import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AppRecords, DailyCount } from "../types";
import { getAppDataDir } from "../lib/storage";

interface RecordsViewProps {
  records: AppRecords | null;
  onExport: () => void;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

type Tab = "challenge" | "drill" | "rapid" | "daily";

export default function RecordsView({ records, onExport }: RecordsViewProps) {
  const [tab, setTab] = useState<Tab>("challenge");
  const [dataDir, setDataDir] = useState<string | null>(null);

  const showDataDir = async () => {
    const dir = await getAppDataDir();
    setDataDir(dir);
  };

  if (!records) {
    return (
      <Card className="w-full">
        <CardContent className="px-3 py-4 text-center text-muted-foreground text-sm">
          記録を読み込み中...
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader className="pb-1 pt-3 px-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs text-muted-foreground">Records</CardTitle>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" className="text-xs h-6 px-2" onClick={onExport}>
              Export JSON
            </Button>
            <Button size="sm" variant="ghost" className="text-xs h-6 px-2" onClick={showDataDir}>
              保存先
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-3 pb-3">
        {dataDir && (
          <div className="text-xs text-muted-foreground mb-2 break-all">
            保存先: {dataDir}
          </div>
        )}

        {/* タブ */}
        <div className="flex gap-1 mb-2">
          {([
            { id: "challenge" as Tab, label: "Challenge" },
            { id: "drill" as Tab, label: "Drill" },
            { id: "rapid" as Tab, label: "Rapid" },
            { id: "daily" as Tab, label: "Daily" },
          ]).map(t => (
            <Button
              key={t.id}
              size="sm"
              variant={tab === t.id ? "default" : "outline"}
              className="text-xs h-6 px-2"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </Button>
          ))}
        </div>

        <div className="max-h-[200px] overflow-y-auto">
          {tab === "challenge" && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-1">日時</th>
                  <th className="text-right py-1">時間</th>
                  <th className="text-right py-1">回数</th>
                  <th className="text-right py-1">Avg</th>
                  <th className="text-right py-1">音符</th>
                </tr>
              </thead>
              <tbody>
                {records.challengeRecords.slice().reverse().map((r, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="py-1 text-zinc-400">{formatDate(r.date)}</td>
                    <td className="text-right py-1">{r.duration === 60 ? "1m" : `${r.duration}s`}</td>
                    <td className="text-right py-1 text-yellow-300">{r.scratchCount}</td>
                    <td className="text-right py-1">{r.avgIntervalMs ?? "—"}ms</td>
                    <td className="text-right py-1 text-cyan-300">{r.noteDivision ?? "—"}</td>
                  </tr>
                ))}
                {records.challengeRecords.length === 0 && (
                  <tr><td colSpan={5} className="py-2 text-center text-muted-foreground">記録なし</td></tr>
                )}
              </tbody>
            </table>
          )}

          {tab === "drill" && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-1">日時</th>
                  <th className="text-right py-1">時間</th>
                  <th className="text-right py-1">成功</th>
                  <th className="text-right py-1">失敗</th>
                </tr>
              </thead>
              <tbody>
                {records.drillRecords.slice().reverse().map((r, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="py-1 text-zinc-400">{formatDate(r.date)}</td>
                    <td className="text-right py-1">{r.duration === 60 ? "1m" : `${r.duration}s`}</td>
                    <td className="text-right py-1 text-green-400">{r.completedChains}</td>
                    <td className="text-right py-1 text-red-400">{r.failedChains}</td>
                  </tr>
                ))}
                {records.drillRecords.length === 0 && (
                  <tr><td colSpan={4} className="py-2 text-center text-muted-foreground">記録なし</td></tr>
                )}
              </tbody>
            </table>
          )}

          {tab === "rapid" && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-1">日時</th>
                  <th className="text-right py-1">時間</th>
                  <th className="text-right py-1">キー</th>
                  <th className="text-right py-1">回数</th>
                  <th className="text-right py-1">回/秒</th>
                </tr>
              </thead>
              <tbody>
                {records.rapidPressRecords.slice().reverse().map((r, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="py-1 text-zinc-400">{formatDate(r.date)}</td>
                    <td className="text-right py-1">{r.duration === 60 ? "1m" : `${r.duration}s`}</td>
                    <td className="text-right py-1">{r.keyLabel}</td>
                    <td className="text-right py-1 text-cyan-300">{r.pressCount}</td>
                    <td className="text-right py-1">{(r.pressCount / r.duration).toFixed(1)}</td>
                  </tr>
                ))}
                {records.rapidPressRecords.length === 0 && (
                  <tr><td colSpan={5} className="py-2 text-center text-muted-foreground">記録なし</td></tr>
                )}
              </tbody>
            </table>
          )}

          {tab === "daily" && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-1">日付</th>
                  <th className="text-right py-1">スクラッチ</th>
                  <th className="text-right py-1">キー押下</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(records.dailyCounts).sort((a, b) => b[0].localeCompare(a[0])).map(([date, c]: [string, DailyCount]) => (
                  <tr key={date} className="border-b border-border/50">
                    <td className="py-1 text-zinc-400">{date}</td>
                    <td className="text-right py-1 text-yellow-300">{c.totalScratches}</td>
                    <td className="text-right py-1 text-cyan-300">{c.totalKeyPresses}</td>
                  </tr>
                ))}
                {Object.keys(records.dailyCounts).length === 0 && (
                  <tr><td colSpan={3} className="py-2 text-center text-muted-foreground">記録なし</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
