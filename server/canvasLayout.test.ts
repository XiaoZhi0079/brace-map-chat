import assert from 'node:assert/strict'
import test from 'node:test'
import {
  arrangeCanvasTree,
  initialProgressiveTreePositions,
  progressiveVisibleNodeIds,
  resolveCanvasCollisions,
  type CanvasLayoutNode,
} from '../src/canvasLayout.ts'

function tree(): CanvasLayoutNode[] {
  return [
    { id: 'root', expanded: true, position: { x: 0, y: 0 } },
    { id: 'chapter-a', parentId: 'root', expanded: false, position: { x: 0, y: 0 } },
    { id: 'chapter-b', parentId: 'root', expanded: false, position: { x: 0, y: 0 } },
    { id: 'lesson-a1', parentId: 'chapter-a', expanded: false, position: { x: 0, y: 0 } },
    { id: 'lesson-a2', parentId: 'chapter-a', expanded: false, position: { x: 0, y: 0 } },
  ]
}

test('progressive visibility always shows roots and first-level chapters', () => {
  const nodes = tree()
  assert.deepEqual([...progressiveVisibleNodeIds(nodes)], ['root', 'chapter-a', 'chapter-b'])
  nodes[1].expanded = true
  assert.deepEqual(
    [...progressiveVisibleNodeIds(nodes)],
    ['root', 'chapter-a', 'chapter-b', 'lesson-a1', 'lesson-a2'],
  )
})

test('tree arrangement centers parents and separates every visible sibling', () => {
  const nodes = tree()
  nodes[1].expanded = true
  const visible = progressiveVisibleNodeIds(nodes)
  const positions = arrangeCanvasTree(nodes, { visibleIds: visible })
  assert.equal(positions.get('root')?.x, 80)
  assert.equal(positions.get('chapter-a')?.x, 840)
  assert.equal(positions.get('lesson-a1')?.x, 1600)
  assert.ok((positions.get('lesson-a2')?.y ?? 0) > (positions.get('lesson-a1')?.y ?? 0))
  assert.ok((positions.get('chapter-b')?.y ?? 0) > (positions.get('chapter-a')?.y ?? 0))
})

test('initial positions keep hidden descendants near their future parent column', () => {
  const nodes = tree()
  const positions = initialProgressiveTreePositions(nodes)
  assert.equal(positions.size, nodes.length)
  assert.equal(positions.get('lesson-a1')?.x, (positions.get('chapter-a')?.x ?? 0) + 760)
  assert.notEqual(positions.get('lesson-a1')?.y, positions.get('lesson-a2')?.y)
})

test('collision resolution moves only as far down as needed', () => {
  const nodes: CanvasLayoutNode[] = [
    { id: 'one', expanded: true, position: { x: 100, y: 100 } },
    { id: 'two', expanded: false, position: { x: 120, y: 140 } },
    { id: 'three', expanded: false, position: { x: 900, y: 140 } },
  ]
  const positions = resolveCanvasCollisions(nodes)
  assert.equal(positions.get('one')?.y, 100)
  assert.equal(positions.get('two')?.y, 534)
  assert.equal(positions.get('three')?.y, 140)
})
