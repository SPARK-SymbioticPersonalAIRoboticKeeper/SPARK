// Native ChatGPT Projects sidebar folding. No project data or React-owned nodes are moved.
export function classifyNumberedProject(rawTitle) {
  const title = String(rawTitle ?? "").replace(/^[\s\u2800]+/u, "");
  const child = /^([0-9]{1,3})\.([0-9]{2})\.\s+\S/u.exec(title);
  if (child) return { kind: "child", root: child[1], child: child[2] };
  // A malformed child-like prefix ("99. 00.") is neither a child nor an
  // additional parent: otherwise it can disable the valid 99. group entirely.
  if (/^[0-9]{1,3}\.[\s\u2800]+[0-9]{1,3}\./u.test(title)) return null;
  const parent = /^([0-9]{1,3})\.\s+\S/u.exec(title);
  if (parent) return { kind: "parent", root: parent[1] };
  return null;
}

// The native Pinned row exposes its current project route through React's
// navigation props. Match the conversation ID from the row's drop key before
// trusting the route, so a stale/reused React Fiber cannot mislabel a chat.
// No network requests or changes to the actual conversation title are needed.
export function projectIdFromPinnedRoute(route, dropKey) {
  const pinned = /^chatgpt:conversation:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu.exec(
    String(dropKey ?? ""));
  const link = /^\/g\/(g-p-[0-9a-f]{32})\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:[?#]|$)/iu.exec(
    String(route ?? ""));
  if (!pinned || !link || pinned[1].toLowerCase() !== link[2].toLowerCase()) {
    return null;
  }
  return link[1];
}

// Groups are keyed by numeric prefix, not DOM adjacency. Duplicated parent prefixes
// and orphan children are deliberately left untouched (fail open).
export function planNumberedProjectCollapse(titles, classify = classifyNumberedProject) {
  const parents = new Map();
  const children = new Map();
  titles.forEach((title, index) => {
    const result = classify(title);
    if (!result) return;
    const map = result.kind === "parent" ? parents : children;
    const indices = map.get(result.root) ?? [];
    indices.push(index);
    map.set(result.root, indices);
  });
  const result = [];
  for (const [root, indices] of parents) {
    const childIndices = children.get(root) ?? [];
    if (indices.length !== 1 || childIndices.length === 0) continue;
    result.push({ root, parentIndex: indices[0], childIndices });
  }
  return result;
}

function installProjectCollapse(classify, plan, pinnedRouteProjectId) {
  const globalKey = "__sparkProjectCollapse";
  const styleId = "spark-project-collapse-style";
  const toggleSelector = 'button[data-spark-project-toggle="1"]';
  const hiddenSelector = '[data-spark-project-hidden="1"]';
  const previous = window[globalKey];
  // Keep version 2 for compatibility; the layout revision forces a one-time
  // in-place upgrade when a new watcher expression replaces the old one.
  if (previous?.version === 2 && previous.layoutRevision === 5 &&
      typeof previous.refresh === "function") {
    return previous.refresh();
  }
  const priorCollapsed = previous?.collapsed && typeof previous.collapsed === "object"
    ? { ...previous.collapsed } : {};
  if (typeof previous?.restore === "function") previous.restore();

  const controller = {
    version: 2,
    layoutRevision: 5,
    collapsed: Object.assign(Object.create(null), priorCollapsed),
    observer: null,
    pinnedObserver: null,
    pinnedList: null,
    rootObserver: null,
    list: null,
    scheduled: false,
    stopped: false,
    refresh: null,
    restore: null,
  };

  function findProjectList() {
    for (const section of document.querySelectorAll("section")) {
      const header = [...section.querySelectorAll("button")].find((button) =>
        /^(Projects|프로젝트)$/iu.test(button.textContent?.trim() ?? ""));
      if (!header) continue;
      const list = section.querySelector('[role="list"]');
      if (list) return list;
    }
    return null;
  }

  function findPinnedList() {
    for (const section of document.querySelectorAll("section")) {
      const header = [...section.querySelectorAll("button")].find((button) =>
        /^(Pinned|고정됨|고정)$/iu.test(button.textContent?.trim() ?? ""));
      if (!header) continue;
      const list = section.querySelector('[role="list"]');
      if (list) return list;
    }
    return null;
  }

  function projectIdForPinnedRow(row, dropKey) {
    // A real DOM link is preferred if the application exposes one. As of the
    // current Windows ChatGPT build, pinned rows use role=button and keep their
    // navigation href in React Fiber's memoizedProps instead.
    const anchor = row.querySelector('a[href]');
    const anchorId = pinnedRouteProjectId(anchor?.getAttribute("href"), dropKey);
    if (anchorId) return anchorId;

    for (const element of [row, row.parentElement]) {
      if (!element) continue;
      const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
      let fiber = key ? element[key] : null;
      for (let depth = 0; fiber && depth < 14; depth++, fiber = fiber.return) {
        const projectId = pinnedRouteProjectId(fiber.memoizedProps?.href, dropKey);
        if (projectId) return projectId;
      }
    }
    return null;
  }

  function refreshPinnedLabels(entries) {
    const list = findPinnedList();
    if (controller.pinnedList !== list) {
      controller.pinnedObserver?.disconnect();
      controller.pinnedObserver = null;
      controller.pinnedList = list;
      if (list) {
        controller.pinnedObserver = new MutationObserver(scheduleRefresh);
        controller.pinnedObserver.observe(list, {
          childList: true, subtree: true, characterData: true,
        });
      }
    }
    if (!list) return { pinnedCount: 0, pinnedLabeledCount: 0 };

    const projectNamesById = new Map();
    for (const entry of entries) {
      const id = entry.row?.getAttribute("data-app-action-sidebar-project-id");
      const name = entry.row?.getAttribute("data-app-action-sidebar-project-label");
      if (id?.startsWith("g-p-") && name) {
        const trimmed = name.replace(/^[\s\u2800]+/u, "").trim();
        if (trimmed) projectNamesById.set(id, trimmed);
      }
    }

    let pinnedCount = 0;
    let pinnedLabeledCount = 0;
    const active = new Set();
    for (const item of list.children) {
      if (item.getAttribute("role") !== "listitem") continue;
      const dropKey = item.getAttribute("data-pinned-content-tab-drop-key");
      if (!dropKey?.startsWith("chatgpt:conversation:")) continue;
      pinnedCount++;
      const row = item.querySelector('[role="button"].sidebar-item');
      const titles = row?.querySelectorAll('[data-thread-title] span[data-marquee-content]');
      if (!row || !titles?.length) continue;
      const projectId = projectIdForPinnedRow(row, dropKey);
      const projectName = projectId ? projectNamesById.get(projectId) : null;
      if (!projectName) continue; // Fail open on missing navigation/project metadata.
      pinnedLabeledCount++;
      // Native marquee tracks may duplicate the title during overflow/hover.
      for (const title of titles) {
        active.add(title);
        if (title.getAttribute("data-spark-pinned-project-label") !== projectName) {
          title.setAttribute("data-spark-pinned-project-label", projectName);
        }
      }
    }

    // Pinned entries can be moved to another project or rendered anew. Never
    // keep an old prefix when the current ID-to-project match is unavailable.
    for (const title of list.querySelectorAll('[data-spark-pinned-project-label]')) {
      if (!active.has(title)) title.removeAttribute("data-spark-pinned-project-label");
    }
    return { pinnedCount, pinnedLabeledCount };
  }

  function scheduleRefresh() {
    if (controller.scheduled || controller.stopped) return;
    controller.scheduled = true;
    queueMicrotask(() => {
      controller.scheduled = false;
      if (!controller.stopped) {
        try { controller.refresh(); } catch { /* watcher will retry */ }
      }
    });
  }

  // The Projects list itself is owned by React and can be replaced on navigation.
  // The list observer cannot see removal of its own ancestor; watch that boundary
  // separately without rescanning on every unrelated chat/body mutation.
  function observeListReplacement() {
    if (controller.rootObserver || !document.documentElement) return;
    controller.rootObserver = new MutationObserver(() => {
      if (controller.stopped) return;
      if (!controller.list || !controller.list.isConnected ||
          (controller.pinnedList && !controller.pinnedList.isConnected)) {
        scheduleRefresh();
      }
    });
    controller.rootObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function addStyle() {
    if (!document.head || document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent =
      '[data-spark-project-hidden="1"]{display:none!important;}' +
      'button[data-spark-project-toggle="1"]{' +
      'appearance:none;display:inline-flex;align-items:center;justify-content:center;' +
      'flex:0 0 18px;width:18px;height:26px;margin:0 3px 0 0;padding:0;' +
      'border:0;border-radius:4px;background:transparent;color:inherit;' +
      'opacity:.75;cursor:pointer;}' +
      'button[data-spark-project-toggle="1"]:hover{opacity:1;background:var(--bg-surface-hover,transparent);}' +
      'button[data-spark-project-toggle="1"]:focus-visible{outline:2px solid currentColor;outline-offset:1px;}' +
      // The toggle footprint is 18px wide plus 3px right margin = 21 CSS px.
      // Reserve it for every parent. Indent children another 21px from the
      // parent folder icon, independent of any invisible spaces in the title.
      '.sidebar-item[data-spark-project-kind="parent"][data-spark-project-expandable="0"] > :first-child{' +
      'padding-inline-start:21px!important;}' +
      '.sidebar-item[data-spark-project-kind="child"] > :first-child{' +
      'padding-inline-start:42px!important;}' +
      // Native chat titles start at 8px, while Show more starts at 32px.
      // Add the SAME project-title offset (21px parent / 42px child) to both.
      // The full click/hover row remains in place; only its inner padding moves.
      '[role="list"][data-spark-project-chat-indent="parent"]{' +
      '--spark-project-chat-offset:21px;}' +
      '[role="list"][data-spark-project-chat-indent="child"]{' +
      '--spark-project-chat-offset:42px;}' +
      '[role="list"][data-spark-project-chat-indent] > [role="listitem"] ' +
      '[role="button"].sidebar-item{' +
      'padding-inline-start:calc(8px + var(--spark-project-chat-offset))!important;}' +
      '[role="list"][data-spark-project-chat-indent] > [role="listitem"]:has(>button){' +
      'padding-inline-start:calc(32px + var(--spark-project-chat-offset))!important;}' +
      // Presentation only: never replace the React-owned title or click target.
      // The project prefix shares the native marquee's clipping and animation.
      'span[data-marquee-content][data-spark-pinned-project-label]::before{' +
      'content:attr(data-spark-pinned-project-label) "/";white-space:pre;}';
    document.head.appendChild(style);
  }

  function makeChevron(button) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m9 18 6-6-6-6");
    svg.appendChild(path);
    button.appendChild(svg);
  }

  function ensureToggle(row, root) {
    const lead = row.firstElementChild;
    if (!lead) return null;
    let toggle = row.querySelector(toggleSelector);
    if (!toggle) {
      toggle = document.createElement("button");
      toggle.type = "button";
      toggle.dataset.sparkProjectToggle = "1";
      makeChevron(toggle);
      for (const type of ["pointerdown", "mousedown", "keydown"]) {
        toggle.addEventListener(type, (event) => event.stopPropagation());
      }
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const selectedRoot = toggle.dataset.sparkProjectRoot;
        if (!selectedRoot) return;
        controller.collapsed[selectedRoot] = !controller.collapsed[selectedRoot];
        controller.refresh();
      });
      lead.insertBefore(toggle, lead.firstChild);
    }
    toggle.dataset.sparkProjectRoot = root;
    const isCollapsed = controller.collapsed[root] === true;
    toggle.setAttribute("aria-expanded", String(!isCollapsed));
    toggle.setAttribute("aria-label",
      (isCollapsed ? "Expand" : "Collapse") + " child projects of " + root + ".");
    toggle.title = (isCollapsed ? "Expand" : "Collapse") + " " + root + ".*";
    const svg = toggle.querySelector("svg");
    if (svg) svg.style.transform = isCollapsed ? "rotate(0deg)" : "rotate(90deg)";
    return toggle;
  }

  function refresh() {
    if (controller.stopped) return { status: "disabled", version: 2 };
    observeListReplacement();
    const list = findProjectList();
    if (!list) {
      for (const title of document.querySelectorAll('[data-spark-pinned-project-label]')) {
        title.removeAttribute('data-spark-pinned-project-label');
      }
      return { status: "no-project-list", version: 2 };
    }

    if (controller.list !== list) {
      controller.observer?.disconnect();
      controller.list = list;
      controller.observer = new MutationObserver(scheduleRefresh);
      controller.observer.observe(list, { childList: true, subtree: true, characterData: true });
    }

    const entries = [...list.children]
      .filter((item) => item.getAttribute("role") === "listitem")
      .map((item) => {
        const row = item.querySelector('[role="button"].sidebar-item[aria-expanded]');
        return { item, row, title: row?.innerText?.trim() ?? "" };
      });
    const groups = plan(entries.map((entry) => entry.title), classify);
    const expectedRows = new Set(groups.map((group) => entries[group.parentIndex].row));
    const hiddenIndices = new Set();

    for (const group of groups) {
      const parent = entries[group.parentIndex];
      if (parent.row) ensureToggle(parent.row, group.root);
      if (controller.collapsed[group.root] === true) {
        for (const index of group.childIndices) hiddenIndices.add(index);
      }
    }

    for (const button of list.querySelectorAll(toggleSelector)) {
      if (!expectedRows.has(button.closest(".sidebar-item"))) button.remove();
    }

    // Mark the entire native project row, not the title. The native folder
    // icon and its text consequently move together, while React navigation,
    // the project ordering and the server-side project data remain untouched.
    for (const entry of entries) {
      const row = entry.row;
      if (!row) continue;
      const kind = classify(entry.title)?.kind ?? null;
      if (kind && row.getAttribute("data-spark-project-kind") !== kind) {
        row.setAttribute("data-spark-project-kind", kind);
      } else if (!kind && row.hasAttribute("data-spark-project-kind")) {
        row.removeAttribute("data-spark-project-kind");
      }
      if (kind === "parent") {
        const expandable = expectedRows.has(row) ? "1" : "0";
        if (row.getAttribute("data-spark-project-expandable") !== expandable) {
          row.setAttribute("data-spark-project-expandable", expandable);
        }
      } else if (row.hasAttribute("data-spark-project-expandable")) {
        row.removeAttribute("data-spark-project-expandable");
      }

      // The ChatGPT-rendered chat list belongs to this project listitem.
      // Label only that nested list, never the global Recents/Pinned lists.
      // A newly rendered list is relabeled on the next list mutation.
      const chatList = entry.item.querySelector('[role="list"]');
      if (chatList?.closest('[role="listitem"]') === entry.item) {
        if (kind === "parent" || kind === "child") {
          if (chatList.getAttribute("data-spark-project-chat-indent") !== kind) {
            chatList.setAttribute("data-spark-project-chat-indent", kind);
          }
        } else if (chatList.hasAttribute("data-spark-project-chat-indent")) {
          chatList.removeAttribute("data-spark-project-chat-indent");
        }
      }
    }

    entries.forEach(({ item }, index) => {
      const shouldHide = hiddenIndices.has(index);
      if (shouldHide && !item.hasAttribute("data-spark-project-hidden")) {
        item.setAttribute("data-spark-project-hidden", "1");
      } else if (!shouldHide && item.hasAttribute("data-spark-project-hidden")) {
        item.removeAttribute("data-spark-project-hidden");
      }
    });

    const pinned = refreshPinnedLabels(entries);
    addStyle();
    return {
      status: "active",
      version: 2,
      pinnedCount: pinned.pinnedCount,
      pinnedLabeledCount: pinned.pinnedLabeledCount,
      groupCount: groups.length,
      childCount: groups.reduce((total, group) => total + group.childIndices.length, 0),
      hiddenCount: hiddenIndices.size,
      collapsedCount: groups.filter((group) => controller.collapsed[group.root] === true).length,
    };
  }

  function restore() {
    controller.stopped = true;
    controller.observer?.disconnect();
    controller.observer = null;
    controller.pinnedObserver?.disconnect();
    controller.pinnedObserver = null;
    controller.pinnedList = null;
    controller.rootObserver?.disconnect();
    controller.rootObserver = null;
    for (const item of document.querySelectorAll(hiddenSelector)) {
      item.removeAttribute("data-spark-project-hidden");
    }
    for (const button of document.querySelectorAll(toggleSelector)) button.remove();
    for (const row of document.querySelectorAll("[data-spark-project-kind], [data-spark-project-expandable]")) {
      row.removeAttribute("data-spark-project-kind");
      row.removeAttribute("data-spark-project-expandable");
    }
    for (const list of document.querySelectorAll('[data-spark-project-chat-indent]')) {
      list.removeAttribute('data-spark-project-chat-indent');
    }
    for (const title of document.querySelectorAll('[data-spark-pinned-project-label]')) {
      title.removeAttribute('data-spark-pinned-project-label');
    }
    document.getElementById(styleId)?.remove();
    if (window[globalKey] === controller) delete window[globalKey];
    return { status: "restored", version: 2 };
  }

  controller.refresh = refresh;
  controller.restore = restore;
  window[globalKey] = controller;
  return controller.refresh();
}

function restoreProjectCollapse() {
  const controller = window.__sparkProjectCollapse;
  if (typeof controller?.restore === "function") return controller.restore();
  for (const node of document.querySelectorAll('[data-spark-project-hidden="1"]')) {
    node.removeAttribute("data-spark-project-hidden");
  }
  for (const button of document.querySelectorAll('button[data-spark-project-toggle="1"]')) {
    button.remove();
  }
  for (const row of document.querySelectorAll("[data-spark-project-kind], [data-spark-project-expandable]")) {
    row.removeAttribute("data-spark-project-kind");
    row.removeAttribute("data-spark-project-expandable");
  }
  for (const list of document.querySelectorAll('[data-spark-project-chat-indent]')) {
    list.removeAttribute('data-spark-project-chat-indent');
  }
  for (const title of document.querySelectorAll('[data-spark-pinned-project-label]')) {
    title.removeAttribute('data-spark-pinned-project-label');
  }
  document.getElementById("spark-project-collapse-style")?.remove();
  return { status: "restored", version: 2 };
}

export function buildProjectCollapseExpression() {
  return "(() => { const classify = " + classifyNumberedProject.toString() +
    "; const plan = " + planNumberedProjectCollapse.toString() +
    "; const pinnedRouteProjectId = " + projectIdFromPinnedRoute.toString() +
    "; return (" + installProjectCollapse.toString() +
    ")(classify, plan, pinnedRouteProjectId); })()";
}

export function buildProjectCollapseRestoreExpression() {
  return "(" + restoreProjectCollapse.toString() + ")()";
}
