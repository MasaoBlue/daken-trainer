// BPMと間隔msから最も近い音符区分を返す（4〜32の全整数）
export function nearestNoteDivision(intervalMs: number, bpm: number): string {
  const beatMs = 60000 / bpm;
  let best = 4, bestDiff = Infinity;
  for (let d = 4; d <= 32; d++) {
    const noteMs = beatMs / (d / 4);
    const diff = Math.abs(intervalMs - noteMs);
    if (diff < bestDiff) { bestDiff = diff; best = d; }
  }
  return `${best}分相当`;
}

// 音符区分の色（4分=グレー(遅い) → 32分=赤(速い)）
export function noteColor(d: number): string {
  const t = (d - 4) / (32 - 4);
  const r = Math.round(80 + t * 175);
  const g = Math.round(80 - t * 60);
  const b = Math.round(80 - t * 60);
  return `rgb(${r},${g},${b})`;
}
