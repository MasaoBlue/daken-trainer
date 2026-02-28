# 新処理方式のテスト用
import tkinter as tk
from tkinter import ttk, simpledialog, messagebox
import pygame
import websockets
import asyncio
import json
import threading
from queue import Queue
import os
import json
import time
from collections import defaultdict
import logging, logging.handlers
from settings import Settings, playmode, SettingsDialog
from tooltip import ToolTip
import subprocess
from bs4 import BeautifulSoup
import requests
import traceback
import urllib
import webbrowser
import icon

os.makedirs('log', exist_ok=True)
logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)
hdl = logging.handlers.RotatingFileHandler(
    f'log/{os.path.basename(__file__).split(".")[0]}.log',
    encoding='utf-8',
    maxBytes=1024*1024*2,
    backupCount=1,
)
hdl.setLevel(logging.DEBUG)
hdl_formatter = logging.Formatter('%(asctime)s %(filename)s:%(lineno)5d %(funcName)s() [%(levelname)s] %(message)s')
hdl.setFormatter(hdl_formatter)
logger.addHandler(hdl)

try:
    with open('version.txt', 'r') as f:
        SWVER = f.readline().strip()
except Exception:
    SWVER = "v?.?.?"


class JoystickWebSocketServer:
    def __init__(self, root):
        self.time_start = time.perf_counter()
        self.root = root
        self.root.title("Otoge Input Viewer")
        self.icon = tk.PhotoImage(data=icon.icon_data)
        self.root.iconphoto(False, self.icon)
        self.scratch_queue = Queue() # スクラッチだけoff用処理も入れるため分ける
        self.calc_queue = Queue()  # 計算用のキュー、全イベントをここに流す
        self.event_queue = Queue() # HTMLへの出力をすべてここに通す
        self.running = False
        self.clients = set()
        self.today_notes  = 0 # 合計
        self.today_keys   = 0 # 鍵盤部分
        self.today_others = 0 # スクラッチとかツマミとかピックとか
        # スクラッチ判定用
        self.pre_scr_val = [None, None]
        self.pre_scr_direction = [-1, -1]
        self.list_density = []
        self.settings = Settings()
        logger.debug(f'settings = {self.settings.__dict__}')

        self.joystick = [None, None]

        self.root.geometry(f'+{self.settings.lx}+{self.settings.ly}')

        self.setup_gui()
        self.init_pygame()
        self.start_monitor()
        self.start_threads()
        logger.debug('started!')
        if self.settings.auto_update:
            self.check_updates()

    def get_latest_version(self):
        """GitHubから最新版のバージョンを取得する。

        Returns:
            str: バージョン番号
        """
        ret = None
        url = 'https://github.com/dj-kata/otoge_input_viewer/tags'
        r = requests.get(url)
        soup = BeautifulSoup(r.text,features="html.parser")
        for tag in soup.find_all('a'):
            if 'releases/tag/v.' in tag['href']:
                ret = tag['href'].split('/')[-1]
                break # 1番上が最新なので即break
        return ret
    
    def check_updates(self, always_disp_dialog=False):
        ver = self.get_latest_version()
        if (ver != SWVER) and (ver is not None):
            logger.debug(f'現在のバージョン: {SWVER}, 最新版:{ver}')
            ans = tk.messagebox.askquestion('バージョン更新',f'アップデートが見つかりました。\n\n{SWVER} -> {ver}\n\nアプリを終了して更新します。', icon='warning')
            if ans == "yes":
                if os.path.exists('update.exe'):
                    logger.info('アップデート確認のため終了します')
                    res = subprocess.Popen('update.exe')
                    print('fug')
                    self.on_close()
                else:
                    raise ValueError("update.exeがありません")
        else:
            logger.debug(f'お使いのバージョンは最新です({SWVER})')
            if always_disp_dialog:
                messagebox.showinfo("Otoge Input Viewer", f'お使いのバージョンは最新です({SWVER})')

    def get_uptime(self):
        """アプリの起起動時を文字列として返す

        Returns:
            str: HH:MM:SS形式の文字列
        """
        uptime = time.perf_counter() - self.time_start
        uptime_h = int(uptime//3600)
        uptime_m = int((uptime - uptime_h*3600)//60)
        uptime_s = int((uptime-uptime_h*3600-uptime_m*60))
        uptime_str = f"{uptime_h:02d}:{uptime_m:02d}:{uptime_s:02d}"
        return uptime_str

    def tweet(self):
        """本日の打鍵数をTwitterに投稿する
        """
        msg = f"notes: {self.today_notes}"
        if self.settings.playmode == playmode.sdvx:
            msg += f" (key: {self.today_keys}, vol: {self.today_others})\n"
        elif self.settings.playmode in (playmode.iidx_sp, playmode.iidx_dp):
            msg += f" (key: {self.today_keys}, scratch: {self.today_others})\n"
        msg += f"mode: {self.settings.playmode.name}\n"
        msg += f"uptime: {self.get_uptime()}\n#otoge_input_viewer\n"
        encoded_msg = urllib.parse.quote(f"{msg}")
        webbrowser.open(f"https://twitter.com/intent/tweet?text={encoded_msg}")

    def setup_gui(self):
        """GUIの設定を行う
        """
        self.menubar = tk.Menu(self.root)
        self.root.config(menu=self.menubar)
        
        settings_menu = tk.Menu(self.menubar, tearoff=0)
        settings_menu.add_command(label="config", command=self.open_settings_dialog)
        settings_menu.add_command(label="update", command=lambda:self.check_updates(True))
        settings_menu.add_command(label="reset counter", command=self.reset_counter)
        settings_menu.add_command(label="tweet", command=self.tweet)
        self.menubar.add_cascade(label="file", menu=settings_menu)

        ctr_frame = ttk.Frame(self.root)
        ctr_frame.pack(padx=5, pady=0)

        # ジョイパッド情報
        self.joystick_info = []
        self.joystick_info.append(ttk.Label(
            ctr_frame,
            text="接続ジョイパッド: なし",
            font=("Meiryo UI", 10)
        ))
        self.joystick_info[0].grid(row=0, column=0,sticky=tk.W)

        # コントローラ変更ボタン1
        self.change_joystick_btn = ttk.Button(
            ctr_frame,
            text="change",
            command=lambda:self.change_joystick(0),
        )
        self.change_joystick_btn.grid(row=0, column=1,sticky=tk.W)

        # ジョイパッド情報
        self.joystick_info.append(ttk.Label(
            ctr_frame,
            text="接続ジョイパッド: なし",
            font=("Meiryo UI", 10)
        ))
        self.joystick_info[1].grid(row=1, column=0,sticky=tk.W)

        # コントローラ変更ボタン2
        self.change_joystick_btn2 = ttk.Button(
            ctr_frame,
            text="change",
            command=lambda:self.change_joystick(1),
        )
        self.change_joystick_btn2.grid(row=1, column=1,sticky=tk.W)
        if self.settings.playmode != playmode.iidx_dp:
            self.change_joystick_btn2.config(state='disable')

        main_frame = ttk.Frame(self.root, padding=6)
        main_frame.pack(fill=tk.BOTH, expand=True)

        # モード表示
        self.mode_label = ttk.Label(main_frame, text=f'mode: {self.settings.playmode.name}', font=('Meiryo UI', 10))
        self.mode_label.grid(row=0, sticky=tk.W)

        # ボタンカウンター
        self.counter_label = ttk.Label(
            main_frame,
            text="notes: 0",
            font=("Meiryo UI", 10)
        )
        self.counter_label.grid(row=1, sticky=tk.W)

        # サーバー状態表示
        self.server_status = ttk.Label(
            main_frame,
            text=f"WebSocket port: {self.settings.port}",
            font=("Meiryo UI", 10)
        )
        self.server_status.grid(row=2, sticky=tk.W)

        # uptime表示
        self.uptime_label = ttk.Label(
            main_frame,
            text=f"uptime: 00:00:00",
            font=("Meiryo UI", 10)
        )
        self.uptime_label.grid(row=3, sticky=tk.W)

        # その他情報表示
        self.other_info = ttk.Label(
            main_frame,
            text=f"",
            font=("Meiryo UI", 10)
        )
        self.other_info.grid(row=4, sticky=tk.W)

    def start_monitor(self):
        # ジョイパッド監視スレッド
        self.joystick_thread = threading.Thread(
            target=self.monitor_thread,
            daemon=True
        )
        self.joystick_thread.start()

    def start_threads(self):
        """スレッドの起動処理
        """
        self.running = True
        # WebSocketサーバースレッド（初期状態では非起動）
        self.server_thread = threading.Thread(
            target=self.run_websocket_server,
            daemon=True
        )
        self.server_thread.start()

        # 皿処理スレッド
        self.density_thread = threading.Thread(
            target=self.thread_density,
            daemon=True
        )
        self.density_thread.start()

        # 計算用スレッド
        self.calc_thread = threading.Thread(
            target=self.thread_calc,
            daemon=True
        )
        self.calc_thread.start()

        # 時計更新用スレッド
        self.uptime_thread = threading.Thread(
            target=self.thread_uptime,
            daemon=True
        )
        self.uptime_thread.start()

    def open_settings_dialog(self):
        """設定ウィンドウを開く
        """
        dialog = SettingsDialog(self.root, self.settings)
        self.root.wait_window(dialog)
        self.settings.load()
        self.settings.disp()
        self.update_server_status_display()
        if self.settings.playmode == playmode.iidx_dp:
            self.change_joystick_btn2.config(state='enable')
        else:
            if self.settings.connected_idx[1] is not None:
                self.change_joystick_btn2.config(state='disable')
                self.joystick[1].quit()
                self.joystick[1] = None
                self.joystick_info[1].config(text=f"joypad disconnected", foreground='red')
                self.settings.connected_idx[1] = None
        self.toggle_server()

    def change_joystick(self, controller_pos:int):
        """検出するジョイパッドを変更する

        Args:
            controller_pos (int): DP時に使うコントローラ0,1のどちらを変更するか
        """
        count = pygame.joystick.get_count()
        logger.debug(f'pos={controller_pos}, count={count}')
        if count < 1:
            return
        else:
            if count == 1:
                if self.settings.playmode != playmode.iidx_dp:
                    if (self.settings.connected_idx[controller_pos] is None) or (self.joystick[controller_pos] is None):
                        self.reconnect_joystick(controller_pos, 0)
                else: # DPの場合、コントローラ1つなら他方に移動
                    if self.settings.connected_idx[1-controller_pos] is not None:
                        if self.joystick[1-controller_pos] is not None:
                            self.joystick[1-controller_pos].quit()
                        self.joystick[1-controller_pos] = None
                        self.joystick_info[1-controller_pos].config(text=f"joypad disconnected", foreground='red')
                        self.settings.connected_idx[1-controller_pos] = None
                    self.reconnect_joystick(controller_pos, 0)

            else: # コントローラ2つ以上
                if self.settings.playmode != playmode.iidx_dp:
                    idx = (self.joystick[controller_pos].get_id() + 1) % count
                    self.reconnect_joystick(controller_pos, idx)
                else: # DPかつコントローラ2つ以上検出済みの場合
                    if self.joystick[controller_pos] is None:
                        chk_used = [0]*count # 各コントローラが使われているかどうか
                        for i in range(2):
                            if self.settings.connected_idx[i] is not None:
                                chk_used[self.settings.connected_idx[i]] = 1
                        for i,flg in enumerate(chk_used):
                            if flg == 0:
                                idx = i # 必ず1回は通るはず
                                break
                    else:
                        idx = (self.joystick[controller_pos].get_id() + 1) % count
                    if self.settings.connected_idx[1-controller_pos] == idx: # 他方のコントローラの割当を奪う場合
                        idx_other = self.joystick[controller_pos].get_id()
                        self.reconnect_joystick(1-controller_pos, idx_other)
                    self.reconnect_joystick(controller_pos, idx)
        logger.debug(f'self.joystick = {self.joystick}')


    def reconnect_joystick(self, controller_pos:int=0, idx:int=0):
        """コントローラへの再接続処理。

        Args:
            controller_pos (int): 0,1のどちらのコントローラか
            idx (int): idx番のジョイパッドに接続
        """
        try:
            self.joystick[controller_pos] = pygame.joystick.Joystick(idx)
            self.joystick[controller_pos].init()
            name = self.joystick[controller_pos].get_name()
            self.joystick_info[controller_pos].config(text=f"connected: {name} (ID: {idx})", foreground='blue')
            self.settings.connected_idx[controller_pos] = idx
        except pygame.error as e:
            logger.error(f"ジョイパッド接続エラー: {e}")

    def init_pygame(self):
        """初回起動時のコントローラ初期化処理
        """
        pygame.init()
        pygame.joystick.init()
        count = pygame.joystick.get_count()
        logger.debug(f"count={count}, connected_idx={self.settings.connected_idx}")
        for controller_pos in range(2):
            try:
                if count == 0:
                    logger.debug('No joystick detected')
                else: # コントローラが接続されている
                    if self.settings.connected_idx[controller_pos] is not None:
                        self.reconnect_joystick(controller_pos, self.settings.connected_idx[controller_pos])
                        logger.debug(f'pos{controller_pos} connected (idx={self.settings.connected_idx[controller_pos]})')
                self.change_joystick_btn.config(state=tk.NORMAL)
            except pygame.error as e:
                logger.error(e)
                self.joystick_info[controller_pos].config(text=str(e), foreground="red")

    def thread_density(self):
        """scratch処理用スレッド。リリース/密度の送信及び皿オフの扱いを入れる。scratch_queueのデータを受信してevent_queueに送る。
        """
        print('scratch thread start')
        time_last_sent = 0 # 最後に送信した時間
        while True:
            cur_time = time.perf_counter()
            if cur_time - time_last_sent > self.settings.density_interval: # 各種出力
                if len(self.list_density) > 0: # 密度の出力
                    if cur_time - self.list_density[-1] > self.settings.density_interval:
                        self.list_density = []
                    for i in range(len(self.list_density)):
                        if cur_time - self.list_density[i] <= self.settings.density_interval:
                            break
                    self.list_density = self.list_density[i:] # 直近5秒以内の範囲だけに整形
                    if (len(self.list_density) == 0) or (cur_time == self.list_density[0]):
                        density = 0.0
                    else:
                        density = len(self.list_density) / (cur_time - self.list_density[0])
                    event_data = {
                        'type': 'density',
                        'value': f"{density:.1f}"
                    }
                    self.event_queue.put(event_data)
                time_last_sent = cur_time
            time.sleep(0.1)

    def thread_calc(self):
        """release及びdensityの計算用スレッド。
        """
        SEND_INTERVAL  = 0.5 # 送信周期
        time_last_active = defaultdict(int) # 各鍵盤で最後にpushされた時刻を記録。
        list_allkeys = [] # 全鍵盤用のログ保存リスト
        list_eachkey = defaultdict(list)
        list_last_scratch = defaultdict(str) # 最後にどの向きだったか, axisごとに用意
        print('calc thread start')
        while True:
            tmp = self.calc_queue.get()
            cur_time = time.perf_counter()
            if tmp['type'] == 'button': # 鍵盤
                key = tmp['button'] + tmp['controller_side']*7 # どの鍵盤か
                if tmp['state'] == 'down':
                    time_last_active[key] = cur_time
                    self.list_density.append(cur_time) # LNは関係なく密度計算には使う
                else:
                    tmp_release = cur_time - time_last_active[key]
                    if tmp_release < self.settings.ln_threshold/1000:
                        list_allkeys.append(tmp_release)
                        list_eachkey[key].append(tmp_release)
                        # リリース出力
                        if len(list_allkeys) > self.settings.size_release_hist:
                            list_allkeys.pop(0)
                        release = sum(list_allkeys) / len(list_allkeys)
                        event_data = {
                            'type': 'release',
                            'value': f"{release*1000:.1f}"
                        }
                        self.event_queue.put(event_data)

                        if len(list_eachkey[key]) > self.settings.size_release_key_hist:
                            list_eachkey[key].pop(0)
                        release = sum(list_eachkey[key]) / len(list_eachkey[key])
                        event_data = {
                            'type': 'release_eachkey',
                            'button': key,
                            'value': f"{release*1000:.1f}"
                        }
                        self.event_queue.put(event_data)

            elif tmp['type'] == 'axis': # スクラッチ
                if tmp['direction'] != list_last_scratch[tmp['axis']]:
                    self.list_density.append(cur_time)
                list_last_scratch[tmp['axis']] = tmp['direction']

    def thread_uptime(self):
        """uptimeの表示更新用スレッド
        """
        while True:
            uptime = self.get_uptime()
            self.uptime_label.config(text=f"uptime: {uptime}")
            time.sleep(1)

    def is_valid_event(self, event):
        ret = False
        if event.type == pygame.JOYBUTTONDOWN:
            if self.settings.playmode == playmode.iidx_sp:
                #if event.button <= 6 and event.instance_id == self.settings.connected_idx[0]:
                if event.button <= 6 :
                    ret = True
            elif self.settings.playmode == playmode.iidx_dp:
                #if event.button <= 6 and event.joy in self.settings.connected_idx:
                if event.button <= 6 :
                    ret = True
            elif self.settings.playmode==playmode.sdvx:
                if event.button >=1 and event.button<=6:
                    ret = True
        elif event.type == pygame.JOYAXISMOTION:
            if self.settings.playmode in (playmode.iidx_sp, playmode.iidx_dp):
                if event.axis==0:
                    ret = True
            elif self.settings.playmode==playmode.sdvx:
                if event.axis in (0,1):
                    ret = True
        elif event.type in (pygame.JOYBUTTONUP, pygame.JOYDEVICEADDED, pygame.JOYDEVICEREMOVED):
            ret = True
        if self.settings.debug_mode:
            logger.debug(f'event = {event}')
            logger.debug(f'ret = {ret}')
        return ret

    def monitor_thread(self):
        """ジョイパッドの入力イベントを受け取るループ
        """
        print('monitor_thread start')
        while True:
            try:
                for event in pygame.event.get():
                    if self.settings.debug_mode:
                        logger.debug(event)
                    # モードごとに必要なノートのみ通すための判定処理
                    if not self.is_valid_event(event):
                        continue
                    self.process_joystick_event(event)
                if pygame.joystick.get_count() == 0:
                    for i in range(2):
                        self.joystick_info[0].config(text=f"joypad disconnected", foreground='red')
            except Exception as e:
                logger.debug(traceback.format_exc())
            pygame.time.wait(20)

    def process_joystick_event(self, event):
        """1つのジョイパッド入力イベントを読み込んでwebsocket出力に変換する。

        Args:
            event (pygame.event): 入力イベント
        """
        event_data = None

        # TODO 切断時の対策(現IDの接続ならNoneにする)、再接続時の対策
        controller_side = 0
        if hasattr(event, 'joy'):
            if self.settings.connected_idx[0]!=event.joy:
                controller_side = 1
        if event.type == pygame.JOYAXISMOTION:
            out_direction = -1
            if self.pre_scr_val[event.axis] is not None:
                if event.value > self.pre_scr_val[event.axis]:
                    out_direction = 1
                elif event.value < self.pre_scr_val[event.axis]:
                    out_direction = 0
            self.pre_scr_val[event.axis] = event.value
            event_data = {
                'type': 'axis',
                'axis': event.axis,
                'direction': out_direction,
                'pos': event.axis*2 + out_direction,
                'value': 1,
                'controller_side': controller_side,
                'value_org': event.value,
            }
            if out_direction != self.pre_scr_direction[event.axis]:
                self.today_notes += 1
                self.today_others += 1
                self.root.after(0, self.update_counter_display)
                self.event_queue.put({'type':'notes', 'value':self.today_notes})
            self.pre_scr_direction[event.axis] = out_direction
        elif event.type == pygame.JOYBUTTONDOWN:
            self.today_notes += 1
            self.today_keys += 1
            self.root.after(0, self.update_counter_display)
            self.event_queue.put({'type':'notes', 'value':self.today_notes})
            event_data = {
                'type': 'button',
                'button': event.button,
                'state': 'down',
                'controller_side': controller_side,
            }
        elif event.type == pygame.JOYBUTTONUP:
            event_data = {
                'type': 'button',
                'button': event.button,
                'state': 'up',
                'controller_side': controller_side,
            }
        elif event.type == pygame.JOYDEVICEADDED:
            if pygame.joystick.get_count() == 1:
                self.reconnect_joystick(0, 0)
            else:
                if self.settings.playmode != playmode.iidx_dp:
                    if pygame.joystick.get_count() == 2:
                        if self.joystick[0] is None:
                            self.reconnect_joystick(0, event.device_index)
        elif event.type == pygame.JOYDEVICEREMOVED:
            for i in range(2):
                if self.joystick[i].get_instance_id() == event.instance_id:
                    self.settings.connected_idx[i] = None
                    self.joystick_info[i].config(text=f"joypad disconnected", foreground='red')
                    logger.debug(f'joypad {i} disconnected. connected_idx={self.settings.connected_idx}')
            if self.settings.playmode != playmode.iidx_dp:
                if pygame.joystick.get_count() > 0:
                    self.reconnect_joystick(0)
        
        if event_data:
            self.calc_queue.put(event_data)
            self.event_queue.put(event_data)

    def reset_counter(self):
        self.today_notes = 0
        self.today_keys = 0
        self.today_others = 0
        self.time_start = time.perf_counter()
        self.counter_label.config(text=f"notes: {self.today_notes}")

    def update_counter_display(self):
        if self.settings.playmode == playmode.sdvx:
            self.counter_label.config(text=f"notes: {self.today_notes} (key: {self.today_keys} + vol: {self.today_others})")
        else: # 1p or 2p
            self.counter_label.config(text=f"notes: {self.today_notes} (key: {self.today_keys} + scr: {self.today_others})")

    async def websocket_handler(self, websocket):
        self.clients.add(websocket)
        try:
            async for message in websocket:
                pass
        finally:
            self.clients.remove(websocket)

    async def send_joystick_events(self):
        while self.running:
            events = []
            # キュー内の全イベントを取得
            while not self.event_queue.empty():
                events.append(self.event_queue.get())

            if events:
                message = json.dumps(events)  # 配列形式で送信
                for client in self.clients.copy():
                    try:
                        await client.send(message)
                    except:
                        self.clients.remove(client)
            await asyncio.sleep(0.001)  # 送信間隔調整

    async def main_server(self):
        async with websockets.serve(self.websocket_handler, "0.0.0.0", 8765):
            await self.send_joystick_events()

    def run_websocket_server(self):
        asyncio.set_event_loop(asyncio.new_event_loop())
        self.loop = asyncio.get_event_loop()
        self.loop.run_until_complete(self.main_server())

    def update_server_status_display(self):
        status_text = "停止中" if not self.running else "稼働中"
        self.server_status.config(
            text=f"WebSocket: {status_text} (ポート: {self.settings.port})"
        )
        self.mode_label.config(text=f"mode: {self.settings.playmode.name}")

    def load_settings(self):
        if os.path.exists(self.CONFIG_FILE):
            try:
                with open(self.CONFIG_FILE, 'r') as f:
                    return {**self.DEFAULT_SETTINGS, **json.load(f)}
            except:
                return self.DEFAULT_SETTINGS.copy()
        return self.DEFAULT_SETTINGS.copy()

    async def main_server(self):
        async with websockets.serve(
            self.websocket_handler,
            '0.0.0.0',
            self.settings.port
        ):
            await self.send_joystick_events()

    def toggle_server(self):
        logger.debug('')
        if self.server_thread.is_alive():
            self.running = False
            self.server_thread.join()
            self.update_server_status_display()
            self.loop.stop()
            while self.loop.is_running():
                time.sleep(0.3)
            self.loop.close()
        
        self.running = True
        self.server_thread = threading.Thread(
            target=self.run_websocket_server,
            daemon=True
        )
        self.server_thread.start()

        self.update_server_status_display()

        self.joystick_thread = threading.Thread(
            target=self.monitor_thread,
            daemon=True
        )
        self.joystick_thread.start()

    def on_close(self):
        """メインウィンドウ終了時に実行される関数
        """
        logger.debug('exit')
        self.running = False
        self.settings.lx = self.root.winfo_x()
        self.settings.ly = self.root.winfo_y()
        self.settings.save()
        pygame.quit()
        self.root.destroy()

if __name__ == "__main__":
    try:
        root = tk.Tk()
        app = JoystickWebSocketServer(root)
        root.protocol("WM_DELETE_WINDOW", app.on_close)
        root.minsize(300,200)
        root.mainloop()
    except Exception as e:
        logger.error(traceback.format_exc())
