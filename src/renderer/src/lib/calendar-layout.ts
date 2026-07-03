// Week-view overlap layout: cluster overlapping intervals, greedily assign
// each event the first free column, and give every event in a cluster the
// cluster's column count so widths divide evenly (Google-style side-by-side).

export interface LaidOut<T> {
  item: T
  col: number
  cols: number
}

export function layoutDayEvents<T>(
  items: T[],
  start: (t: T) => number,
  end: (t: T) => number
): LaidOut<T>[] {
  const sorted = [...items].sort((a, b) => start(a) - start(b) || end(b) - end(a))
  const out: LaidOut<T>[] = []
  let colEnds: number[] = [] // per-column running end within the current cluster
  let clusterStart = 0 // index into `out` where the current cluster began
  let clusterMaxEnd = -Infinity

  const closeCluster = (): void => {
    for (let i = clusterStart; i < out.length; i++) out[i].cols = colEnds.length
  }

  for (const item of sorted) {
    const s = start(item)
    if (out.length > clusterStart && s >= clusterMaxEnd) {
      closeCluster()
      colEnds = []
      clusterStart = out.length
      clusterMaxEnd = -Infinity
    }
    let col = colEnds.findIndex((e) => e <= s)
    if (col === -1) {
      col = colEnds.length
      colEnds.push(0)
    }
    colEnds[col] = end(item)
    clusterMaxEnd = Math.max(clusterMaxEnd, end(item))
    out.push({ item, col, cols: 1 })
  }
  closeCluster()
  return out
}
