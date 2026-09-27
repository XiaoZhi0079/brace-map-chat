export type CanvasLayoutNode = {
  id: string
  parentId?: string
  expanded: boolean
  position: { x: number; y: number }
}

export type CanvasLayoutOptions = {
  compactAll?: boolean
  visibleIds?: ReadonlySet<string>
}

const COMPACT_WIDTH = 310
const COMPACT_HEIGHT = 76
const EXPANDED_WIDTH = 640
const EXPANDED_HEIGHT = 400
const STUDY_COLUMN_STEP = 760
const OVERVIEW_COLUMN_STEP = 430
const STUDY_ROW_GAP = 48
const OVERVIEW_ROW_GAP = 34
const FOREST_GAP = 96

function isRoot(node: CanvasLayoutNode, byId: ReadonlyMap<string, CanvasLayoutNode>) {
  return !node.parentId || !byId.has(node.parentId)
}

function nodeHeight(node: CanvasLayoutNode, compactAll: boolean) {
  return node.expanded && !compactAll ? EXPANDED_HEIGHT : COMPACT_HEIGHT
}

function nodeWidth(node: CanvasLayoutNode, compactAll: boolean) {
  return node.expanded && !compactAll ? EXPANDED_WIDTH : COMPACT_WIDTH
}

export function progressiveVisibleNodeIds(nodes: CanvasLayoutNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const childrenByParent = new Map<string, CanvasLayoutNode[]>()
  for (const node of nodes) {
    if (!node.parentId || !byId.has(node.parentId)) continue
    const siblings = childrenByParent.get(node.parentId) ?? []
    siblings.push(node)
    childrenByParent.set(node.parentId, siblings)
  }

  const visible = new Set<string>()
  const queue = nodes.filter((node) => isRoot(node, byId))
  for (const root of queue) visible.add(root.id)

  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]
    if (!isRoot(parent, byId) && !parent.expanded) continue
    for (const child of childrenByParent.get(parent.id) ?? []) {
      if (visible.has(child.id)) continue
      visible.add(child.id)
      queue.push(child)
    }
  }
  return visible
}

export function arrangeCanvasTree(nodes: CanvasLayoutNode[], options: CanvasLayoutOptions = {}) {
  const compactAll = options.compactAll === true
  const visibleIds = options.visibleIds ?? new Set(nodes.map((node) => node.id))
  const visibleNodes = nodes.filter((node) => visibleIds.has(node.id))
  const byId = new Map(visibleNodes.map((node) => [node.id, node]))
  const childrenByParent = new Map<string, CanvasLayoutNode[]>()
  for (const node of visibleNodes) {
    if (!node.parentId || !byId.has(node.parentId)) continue
    const children = childrenByParent.get(node.parentId) ?? []
    children.push(node)
    childrenByParent.set(node.parentId, children)
  }

  const rowGap = compactAll ? OVERVIEW_ROW_GAP : STUDY_ROW_GAP
  const columnStep = compactAll ? OVERVIEW_COLUMN_STEP : STUDY_COLUMN_STEP
  const blockHeights = new Map<string, number>()
  const measuring = new Set<string>()

  const measure = (node: CanvasLayoutNode): number => {
    const cached = blockHeights.get(node.id)
    if (typeof cached === 'number') return cached
    if (measuring.has(node.id)) return nodeHeight(node, compactAll)
    measuring.add(node.id)
    const children = childrenByParent.get(node.id) ?? []
    const childrenHeight = children.reduce((total, child, index) => (
      total + measure(child) + (index ? rowGap : 0)
    ), 0)
    const height = Math.max(nodeHeight(node, compactAll), childrenHeight)
    measuring.delete(node.id)
    blockHeights.set(node.id, height)
    return height
  }

  const positions = new Map<string, { x: number; y: number }>()
  const placing = new Set<string>()
  const place = (node: CanvasLayoutNode, depth: number, blockTop: number) => {
    if (placing.has(node.id)) return
    placing.add(node.id)
    const blockHeight = measure(node)
    const ownHeight = nodeHeight(node, compactAll)
    positions.set(node.id, {
      x: 80 + depth * columnStep,
      y: 40 + blockTop + (blockHeight - ownHeight) / 2,
    })

    const children = childrenByParent.get(node.id) ?? []
    const childrenHeight = children.reduce((total, child, index) => (
      total + measure(child) + (index ? rowGap : 0)
    ), 0)
    let childTop = blockTop + Math.max(0, (blockHeight - childrenHeight) / 2)
    for (const child of children) {
      place(child, depth + 1, childTop)
      childTop += measure(child) + rowGap
    }
    placing.delete(node.id)
  }

  const roots = visibleNodes.filter((node) => isRoot(node, byId))
  let forestTop = 0
  for (const root of roots) {
    place(root, 0, forestTop)
    forestTop += measure(root) + FOREST_GAP
  }
  return positions
}

export function resolveCanvasCollisions(nodes: CanvasLayoutNode[], compactAll = false) {
  const ordered = [...nodes].sort((left, right) => (
    left.position.y - right.position.y || left.position.x - right.position.x
  ))
  const positions = new Map<string, { x: number; y: number }>()
  const placed: Array<{ x: number; y: number; width: number; height: number }> = []
  const gap = 34

  for (const node of ordered) {
    const width = nodeWidth(node, compactAll)
    const height = nodeHeight(node, compactAll)
    let y = node.position.y
    let moved = true
    while (moved) {
      moved = false
      for (const other of placed) {
        const overlapsHorizontally = node.position.x < other.x + other.width + gap
          && node.position.x + width + gap > other.x
        const overlapsVertically = y < other.y + other.height + gap
          && y + height + gap > other.y
        if (!overlapsHorizontally || !overlapsVertically) continue
        y = other.y + other.height + gap
        moved = true
      }
    }
    positions.set(node.id, { x: node.position.x, y })
    placed.push({ x: node.position.x, y, width, height })
  }
  return positions
}

export function initialProgressiveTreePositions(nodes: CanvasLayoutNode[]) {
  const visibleIds = progressiveVisibleNodeIds(nodes)
  const positions = arrangeCanvasTree(nodes, { visibleIds })
  const byParent = new Map<string, CanvasLayoutNode[]>()
  for (const node of nodes) {
    if (!node.parentId) continue
    const children = byParent.get(node.parentId) ?? []
    children.push(node)
    byParent.set(node.parentId, children)
  }

  const queue = nodes.filter((node) => positions.has(node.id))
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]
    const parentPosition = positions.get(parent.id) ?? parent.position
    const hiddenChildren = (byParent.get(parent.id) ?? []).filter((child) => !positions.has(child.id))
    hiddenChildren.forEach((child, childIndex) => {
      positions.set(child.id, {
        x: parentPosition.x + STUDY_COLUMN_STEP,
        y: parentPosition.y + (childIndex - (hiddenChildren.length - 1) / 2) * (COMPACT_HEIGHT + STUDY_ROW_GAP),
      })
      queue.push(child)
    })
  }
  return positions
}
