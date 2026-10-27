// Protocol experiment only. No application route, editor binding or session transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoroDoc, LoroText } from 'loro-crdt';

function document(peer) {
  const doc = new LoroDoc();
  doc.setPeerId(String(peer));
  doc.configTextStyle({ bold: { expand: 'after' }, italic: { expand: 'after' } });
  return doc;
}
function block(doc, id, type, value = '', parent) {
  const node = doc.getTree('blocks').createNode(parent?.id);
  node.data.set('blockId', id);
  node.data.set('type', type);
  if (value) node.data.setContainer('text', new LoroText()).insert(0, value);
  return node;
}
function seed() {
  const doc = document(1);
  block(doc, 'a', 'paragraph', 'alpha');
  block(doc, 'b', 'paragraph', 'bravo');
  block(doc, 'quote', 'blockquote');
  block(doc, 'task', 'taskItem', 'action').data.set('checked', false);
  const table = block(doc, 'table', 'table');
  const row = block(doc, 'row', 'tableRow', '', table);
  block(doc, 'cell-a', 'tableCell', 'owner', row);
  block(doc, 'cell-b', 'tableCell', 'ready', row);
  doc.commit();
  return doc;
}
function node(doc, id) {
  const result = doc.getTree('blocks').getNodes().find(n => n.data.get('blockId') === id);
  assert.ok(result, `Missing live block ${id}`);
  return result;
}
const text = (doc, id) => node(doc, id).data.get('text');
function clone(doc, peer) { const copy = document(peer); copy.import(doc.export({ mode: 'snapshot' })); return copy; }
function state(doc) {
  const tree = doc.getTree('blocks');
  const nodes = tree.getNodes();
  const ids = nodes.map(n => n.data.get('blockId'));
  assert.equal(new Set(ids).size, ids.length, 'Duplicate application block identity');
  return {
    tree: tree.toJSON(),
    deltas: nodes.filter(n => n.data.get('text') instanceof LoroText)
      .map(n => [n.data.get('blockId'), n.data.get('text').toDelta()])
      .sort(([a], [b]) => a.localeCompare(b)),
  };
}
function converge(base, operations) {
  const peers = operations.map((operation, i) => {
    const peer = clone(base, 11 + i);
    operation(peer); peer.commit(); return peer;
  });
  const updates = peers.map(peer => peer.export({ mode: 'update' }));
  let expected;
  // Reordered and duplicate delivery, including dependency-free cold server restart.
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0], [0, 2, 1], [2, 0, 1]]) {
    const server = clone(base, 100);
    for (const i of order.filter(i => i < updates.length)) { server.import(updates[i]); server.import(updates[i]); }
    const result = state(server);
    if (expected) assert.deepEqual(result, expected); else expected = result;
    for (const peer of peers) { peer.import(server.export({ mode: 'update' })); assert.deepEqual(state(peer), expected); }
    const restarted = clone(server, 101);
    assert.deepEqual(state(restarted), expected);
  }
  return peers[0];
}

test('concurrent inserts at one position retain all three intents deterministically', () => {
  const result = converge(seed(), ['X', 'Y', 'Z'].map(value => doc => text(doc, 'a').insert(2, value)));
  const value = text(result, 'a').toString();
  for (const valuePart of ['X', 'Y', 'Z']) assert.ok(value.includes(valuePart));
  assert.equal(value.replace(/[XYZ]/g, ''), 'alpha');
});
test('disjoint block text edits retain both changes', () => {
  const result = converge(seed(), [d => text(d, 'a').insert(0, 'A:'), d => text(d, 'b').insert(0, 'B:')]);
  assert.equal(text(result, 'a').toString(), 'A:alpha');
  assert.equal(text(result, 'b').toString(), 'B:bravo');
});
test('moving an existing block concurrently with editing keeps identity and text', () => {
  const base = seed(), original = node(base, 'a').id;
  const result = converge(base, [d => node(d, 'a').move(node(d, 'quote')), d => text(d, 'a').insert(5, '!')]);
  assert.equal(node(result, 'a').id, original);
  assert.equal(node(result, 'a').parent().data.get('blockId'), 'quote');
  assert.equal(text(result, 'a').toString(), 'alpha!');
});
test('concurrent opposite-parent moves converge without a parent cycle', () => {
  const result = converge(seed(), [d => node(d, 'a').move(node(d, 'b')), d => node(d, 'b').move(node(d, 'a'))]);
  for (const start of result.getTree('blocks').getNodes()) {
    const visited = new Set(); let current = start;
    while (current) { assert.ok(!visited.has(current.id), 'Parent cycle'); visited.add(current.id); current = current.parent(); }
  }
});
test('delete versus text edit does not resurrect a deleted block', () => {
  const result = converge(seed(), [d => d.getTree('blocks').delete(node(d, 'a').id), d => text(d, 'a').insert(0, 'pending:')]);
  assert.ok(!result.getTree('blocks').getNodes().some(n => n.data.get('blockId') === 'a'));
});
test('overlapping formatting and inserts converge including rich-text marks', () => {
  const result = converge(seed(), [d => text(d, 'a').mark({ start: 0, end: 5 }, 'bold', true), d => text(d, 'a').insert(2, '!'), d => text(d, 'a').mark({ start: 1, end: 4 }, 'italic', true)]);
  assert.equal(text(result, 'a').toString(), 'al!pha');
  assert.ok(text(result, 'a').toDelta().some(delta => delta.attributes?.bold));
  assert.ok(text(result, 'a').toDelta().some(delta => delta.attributes?.italic));
});
test('check state and concurrent task text remain independent', () => {
  const result = converge(seed(), [d => node(d, 'task').data.set('checked', true), d => text(d, 'task').insert(6, ' owner')]);
  assert.equal(node(result, 'task').data.get('checked'), true);
  assert.equal(text(result, 'task').toString(), 'action owner');
});
test('independent table cell edits preserve row/cell identities and hierarchy', () => {
  const base = seed(), rowId = node(base, 'row').id, cellId = node(base, 'cell-a').id;
  const result = converge(base, [d => text(d, 'cell-a').insert(5, ' A'), d => text(d, 'cell-b').insert(5, ' B')]);
  assert.equal(node(result, 'row').id, rowId); assert.equal(node(result, 'cell-a').id, cellId);
  assert.equal(node(result, 'cell-a').parent().id, rowId);
  assert.equal(node(result, 'row').parent().data.get('blockId'), 'table');
  assert.equal(text(result, 'cell-a').toString(), 'owner A');
  assert.equal(text(result, 'cell-b').toString(), 'ready B');
});
test('causal update received before its dependency resolves after dependency arrives', () => {
  const base = seed(), author = clone(base, 11), receiver = clone(base, 12);
  const before = author.version(); text(author, 'a').insert(5, '1'); author.commit();
  const afterFirst = author.version(), first = author.export({ mode: 'update', from: before });
  text(author, 'a').insert(6, '2'); author.commit();
  const second = author.export({ mode: 'update', from: afterFirst });
  receiver.import(second); receiver.import(second); receiver.import(first);
  assert.deepEqual(state(receiver), state(author));
  assert.equal(text(receiver, 'a').toString(), 'alpha12');
});
test('concurrent table deletion and cell edit do not revive the table subtree', () => {
  const result = converge(seed(), [d => d.getTree('blocks').delete(node(d, 'table').id), d => text(d, 'cell-a').insert(0, 'pending:')]);
  const live = result.getTree('blocks').getNodes().map(n => n.data.get('blockId'));
  for (const id of ['table', 'row', 'cell-a', 'cell-b']) assert.ok(!live.includes(id));
});
test('malformed binary update is rejected without changing visible state', () => {
  const doc = seed(), before = state(doc);
  assert.throws(() => doc.import(new Uint8Array([1, 2, 3, 4])));
  assert.deepEqual(state(doc), before);
});
test('seeded three-peer insertion positions retain every unique intent across delivery orders', () => {
  for (let sample = 0; sample < 64; sample++) {
    const markers = ['①', '②', '③'];
    const result = converge(seed(), markers.map((marker, peer) => d => text(d, 'a').insert((sample * (peer + 3) + peer) % 6, marker)));
    const value = text(result, 'a').toString();
    assert.equal(value.replace(/[①②③]/gu, ''), 'alpha', `Base content changed for sample ${sample}`);
    for (const marker of markers) assert.equal(value.split(marker).length - 1, 1);
  }
});
test('counterexample: raw movable-tree delete versus concurrent move revives the block', () => {
  const result = converge(seed(), [d => d.getTree('blocks').delete(node(d, 'a').id), d => node(d, 'a').move(node(d, 'quote'))]);
  // Characterize the unsafe candidate behavior, not a successful HS acceptance case.
  // HS must not adopt this raw projection: it violates the no-resurrection requirement.
  assert.equal(node(result, 'a').parent().data.get('blockId'), 'quote');
  assert.equal(text(result, 'a').toString(), 'alpha');
});
