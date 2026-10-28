import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import {
  classifyNumberedProject,
  projectIdFromPinnedRoute,
  planNumberedProjectCollapse,
  buildProjectCollapseExpression,
  buildProjectCollapseRestoreExpression,
} from "../src/project-collapse.mjs";

test("top-level N. and child N.NN. numbering are distinguished", () => {
  assert.deepEqual(classifyNumberedProject("20. Infinite Idea"),
    { kind: "parent", root: "20" });
  assert.deepEqual(classifyNumberedProject("\u2800\u280020.00. LazyTrip"),
    { kind: "child", root: "20", child: "00" });
  assert.deepEqual(classifyNumberedProject("   10.50. SPARK_Gate_Android"),
    { kind: "child", root: "10", child: "50" });
  assert.equal(classifyNumberedProject("LazyShopper_SWE2"), null);
  assert.equal(classifyNumberedProject("20.00 Missing final dot"), null);
  assert.equal(classifyNumberedProject("20.00. "), null);
  assert.equal(classifyNumberedProject("20.00. LazyTrip")?.kind, "child");
  assert.deepEqual(classifyNumberedProject("99.00. L"),
    { kind: "child", root: "99", child: "00" });
  assert.equal(classifyNumberedProject("99. 00. L"), null);
  assert.equal(classifyNumberedProject("99. 01. H"), null);
  assert.deepEqual(classifyNumberedProject("40. Infinite Idea"),
    { kind: "parent", root: "40" });
  assert.deepEqual(classifyNumberedProject("99. L"),
    { kind: "parent", root: "99" });
  assert.deepEqual(classifyNumberedProject("99. H"),
    { kind: "parent", root: "99" });
});

test("Pinned project ID is read only from a matching native navigation route", () => {
  const id = "6ac0cf44-3cf0-83ed-b806-9eff70a2dd78";
  const drop = "chatgpt:conversation:" + id;
  const project = "g-p-6aa51cd520448191b50c2d6bb415bbef";
  assert.equal(projectIdFromPinnedRoute("/g/" + project + "/c/" + id, drop), project);
  assert.equal(projectIdFromPinnedRoute("/g/" + project + "/c/" + id + "?a=1", drop), project);
  assert.equal(projectIdFromPinnedRoute("/c/" + id, drop), null);
  assert.equal(projectIdFromPinnedRoute("/g/" + project + "/c/" + id, "chatgpt:conversation:00000000-0000-0000-0000-000000000000"), null);
  assert.equal(projectIdFromPinnedRoute("/g/g-p-untrusted/c/" + id, drop), null);
  assert.equal(projectIdFromPinnedRoute("/g/" + project + "/c/" + id + "/extra", drop), null);
  assert.equal(projectIdFromPinnedRoute(null, drop), null);
  assert.equal(projectIdFromPinnedRoute("/g/" + project + "/c/" + id, null), null);
});

test("folding uses the numeric prefix rather than list adjacency or user-entered spacing", () => {
  const titles = [
    "10. Infinite Idea",
    "\u2800\u280010.00. SPARK",
    "\u2800\u280010.50. SPARK_Gate_Android",
    "20. Infinite Idea",
    "\u2800\u280020.00. LazyTrip",
    "\u2800\u280020.10. LazyShopper",
    "40. Infinite Idea",
    "50. Infinite Idea",
    "\u2800\u280030.00. PhyAI",
    "\u2800\u280050.01. SPARK_Log",
    "\u2800\u280050.99. Todo Recorder",
  ];
  assert.deepEqual(planNumberedProjectCollapse(titles), [
    { root: "10", parentIndex: 0, childIndices: [1, 2] },
    { root: "20", parentIndex: 3, childIndices: [4, 5] },
    { root: "50", parentIndex: 7, childIndices: [9, 10] },
  ]);
});

test("malformed spaced child numbers cannot suppress valid numbered project groups", () => {
  assert.deepEqual(planNumberedProjectCollapse([
    "99. SPARK_Gate_Web", "99.00. L", "99. 01. H",
  ]), [{ root: "99", parentIndex: 0, childIndices: [1] }]);
});

test("duplicate top-level identifiers are not grouped; missing parent leaves child visible", () => {
  assert.deepEqual(planNumberedProjectCollapse([
    "20. First",
    "20. Second",
    "20.00. Child",
    "30.00. Orphan",
    "40. No children",
  ]), []);
});

test("only explicit two-digit child suffixes participate in folding", () => {
  assert.deepEqual(planNumberedProjectCollapse([
    "2. Parent",
    "2.0. Not a child",
    "2.00. Child",
    "20. Other",
    "200. Independent",
    "200.01. Child",
  ]), [
    { root: "2", parentIndex: 0, childIndices: [2] },
    { root: "200", parentIndex: 4, childIndices: [5] },
  ]);
});

test("runtime and restore expressions compile without external dependencies", () => {
  const apply = buildProjectCollapseExpression();
  const restore = buildProjectCollapseRestoreExpression();
  assert.doesNotThrow(() => new Script(apply));
  assert.doesNotThrow(() => new Script(restore));
  assert.match(apply, /data-spark-project-toggle/);
  assert.match(apply, /data-spark-project-hidden/);
  assert.match(apply, /MutationObserver/);
  assert.match(apply, /rootObserver/);
  assert.match(apply, /!controller\.list\.isConnected/);
  assert.match(apply, /rootObserver\?\.disconnect/);
  assert.match(apply, /previous\?\.version === 2/);
  assert.match(apply, /layoutRevision === 5/);
  assert.match(apply, /layoutRevision: 5/);
  assert.match(apply, /data-spark-project-kind/);
  assert.match(apply, /data-spark-project-expandable/);
  assert.match(apply, /padding-inline-start:21px!important/);
  assert.match(apply, /padding-inline-start:42px!important/);
  assert.match(apply, /data-spark-project-chat-indent/);
  assert.match(apply, /--spark-project-chat-offset:21px/);
  assert.match(apply, /--spark-project-chat-offset:42px/);
  assert.match(apply, /padding-inline-start:calc\(8px \+ var\(--spark-project-chat-offset\)\)/);
  assert.match(apply, /padding-inline-start:calc\(32px \+ var\(--spark-project-chat-offset\)\)/);
  assert.match(apply, /chatList\?\.closest\('\[role="listitem"\]'\) === entry\.item/);
  assert.match(apply, /data-spark-pinned-project-label/);
  assert.match(apply, /content:attr\(data-spark-pinned-project-label\) "\/"/);
  assert.match(apply, /data-pinned-content-tab-drop-key/);
  assert.match(apply, /__reactFiber\$/);
  assert.match(apply, /memoizedProps\?\.href/);
  assert.match(apply, /pinnedObserver/);
  assert.match(apply, /pinnedLabeledCount/);
  assert.match(restore, /data-spark-pinned-project-label/);
  assert.match(restore, /data-spark-project-chat-indent/);
  assert.match(restore, /data-spark-project-kind/);
  assert.match(restore, /data-spark-project-expandable/);
  assert.match(restore, /spark-project-collapse-style/);
  assert.doesNotMatch(apply, /localStorage|sessionStorage|fetch\(|XMLHttpRequest/);
});
