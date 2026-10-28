import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const DEFAULT_THEME_PATH = path.join(
  PROJECT_ROOT,
  "config",
  "default-theme.json",
);

export const DEFAULT_COLOR_PROPERTIES = Object.freeze([
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "text-decoration-color",
  "caret-color",
  "fill",
  "stroke",
]);

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/i;
const SAFE_COLOR_VALUE = /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]+|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|var)\([^;{}\r\n]*\))$/i;

export const THEME_COLOR_TOKENS = Object.freeze({
  surfaces: Object.freeze({
    windowBackground: [
      "--color-surface",
      "--color-background-surface",
      "--color-token-main-surface-primary",
    ],
    sidebarBackground: [
      "--color-surface-secondary",
      "--color-background-surface-under",
      "--vscode-sideBar-background",
      "--color-token-side-bar-background",
      "--color-token-bg-primary",
    ],
    editorBackground: [
      "--color-surface-tertiary",
      "--color-background-editor-opaque",
      "--vscode-editor-background",
      "--color-token-bg-secondary",
    ],
    titleBarBackground: ["--codex-titlebar-tint"],
    applicationMenuBackground: [
      "--color-background-application-menu",
      "--color-codex-application-menu",
    ],
    elevatedBackground: [
      "--color-background-elevated-primary",
      "--color-background-elevated-primary-opaque",
      "--color-surface-elevated",
    ],
    elevatedSecondaryBackground: [
      "--color-background-elevated-secondary",
      "--color-surface-elevated-secondary",
      "--color-token-bg-tertiary",
    ],
    controlBackground: [
      "--color-background-control",
      "--color-background-control-opaque",
    ],
    inputBackground: ["--vscode-input-background"],
    dropdownBackground: [
      "--vscode-dropdown-background",
      "--color-token-dropdown-background",
    ],
    menuBackground: ["--vscode-menu-background"],
    codeBackground: [
      "--vscode-textCodeBlock-background",
      "--vscode-textPreformat-background",
    ],
    terminalBackground: ["--vscode-terminal-background"],
    userPromptBackground: [],
    userPromptHover: [],
  }),
  text: Object.freeze({
    primary: [
      "--color-text",
      "--color-text-foreground",
      "--vscode-foreground",
      "--color-token-text-primary",
      "--color-token-foreground",
    ],
    secondary: [
      "--color-text-secondary",
      "--color-text-foreground-secondary",
      "--color-text-secondary-solid",
      "--color-token-text-secondary",
    ],
    tertiary: [
      "--color-text-tertiary",
      "--color-text-foreground-tertiary",
      "--vscode-descriptionForeground",
      "--color-codex-description",
      "--color-token-text-tertiary",
      "--color-token-description-foreground",
    ],
    disabled: ["--color-text-disabled", "--vscode-disabledForeground"],
    inverse: ["--color-text-inverse"],
    accent: ["--color-text-accent"],
    link: [
      "--vscode-textLink-foreground",
      "--color-token-text-link-foreground",
      "--color-token-primary",
    ],
    code: ["--vscode-textPreformat-foreground"],
    titleBar: [],
    userPrompt: [],
    buttonPrimary: ["--color-text-button-primary", "--vscode-button-foreground"],
    buttonSecondary: ["--color-text-button-secondary"],
    info: [
      "--color-text-info",
      "--color-text-info-soft",
      "--color-text-info-solid",
      "--color-text-tip",
      "--color-text-tip-badge",
    ],
    success: ["--color-text-success", "--color-text-success-solid"],
    warning: [
      "--color-text-warning",
      "--color-text-warning-soft",
      "--color-text-warning-solid",
      "--vscode-editorWarning-foreground",
    ],
    danger: [
      "--color-text-danger",
      "--color-text-danger-soft",
      "--color-text-danger-solid",
      "--color-text-error",
      "--vscode-errorForeground",
    ],
  }),
  icons: Object.freeze({
    primary: ["--color-icon-primary", "--vscode-icon-foreground", "--color-codex-icon"],
    secondary: ["--color-icon-secondary"],
    tertiary: ["--color-icon-tertiary"],
    accent: ["--color-icon-accent"],
    success: ["--color-icon-success"],
    warning: ["--color-icon-warning"],
    danger: ["--color-icon-error"],
  }),
  borders: Object.freeze({
    default: [
      "--color-border",
      "--color-token-border",
      "--color-token-border-default",
    ],
    subtle: [
      "--color-border-subtle",
      "--color-border-light",
      "--color-token-border-light",
    ],
    strong: [
      "--color-border-strong",
      "--color-border-heavy",
      "--color-token-border-heavy",
    ],
    focus: [
      "--color-border-focus",
      "--color-ring",
      "--vscode-focusBorder",
      "--color-token-focus-border",
    ],
    input: ["--vscode-input-border", "--color-token-input-border"],
    danger: [
      "--color-border-error",
      "--color-border-danger-outline",
      "--vscode-inputValidation-errorBorder",
    ],
    warning: [
      "--color-border-warning",
      "--color-border-warning-outline",
      "--vscode-inputValidation-warningBorder",
    ],
    userPrompt: [],
  }),
  interactions: Object.freeze({
    hoverBackground: [
      "--color-background-primary-ghost-hover",
      "--vscode-list-hoverBackground",
      "--color-token-list-hover-background",
    ],
    activeBackground: [
      "--color-background-primary-soft-active",
      "--vscode-list-activeSelectionBackground",
    ],
    selectionBackground: [
      "--vscode-editor-selectionBackground",
      "--vscode-terminal-selectionBackground",
      "--vscode-terminal-inactiveSelectionBackground",
    ],
    selectionText: [
      "--vscode-list-activeSelectionForeground",
      "--vscode-list-activeSelectionIconForeground",
    ],
    accentBackground: ["--color-background-accent"],
    accentHover: ["--color-background-accent-hover"],
    accentActive: ["--color-background-accent-active"],
    menuSelection: [
      "--color-codex-application-menu-selection",
      "--vscode-menubar-selectionBackground",
    ],
    dropOverlay: [
      "--color-codex-drop-overlay",
      "--color-codex-drop-prompt",
      "--vscode-editorGroup-dropBackground",
      "--vscode-editorGroup-dropIntoPromptBackground",
    ],
    scrollbarHover: [
      "--vscode-scrollbarSlider-hoverBackground",
      "--color-token-scrollbar-slider-hover-background",
    ],
    caret: ["--color-codex-editor-cursor", "--vscode-editorCursor-foreground"],
    scrim: ["--color-simple-scrim"],
  }),
  buttons: Object.freeze({
    primaryBackground: ["--color-background-button-primary"],
    primaryHover: ["--color-background-button-primary-hover"],
    secondaryBackground: ["--color-background-button-secondary"],
    secondaryHover: ["--color-background-button-secondary-hover"],
    secondaryActive: ["--color-background-button-secondary-active"],
  }),
  status: Object.freeze({
    infoBackground: [
      "--color-background-info-soft",
      "--color-background-tip-soft",
      "--color-background-tip-badge",
    ],
    successBackground: ["--color-background-status-success"],
    warningBackground: ["--color-background-status-warning"],
    dangerBackground: ["--color-background-status-error"],
    infoSolid: ["--color-background-info-solid"],
    successSolid: ["--color-background-success-solid"],
    warningSolid: ["--color-background-warning-solid"],
    dangerSolid: ["--color-background-danger-solid"],
    discoverySolid: ["--color-background-discovery-solid"],
    cautionSolid: ["--color-background-caution-solid"],
    successSurface: ["--color-background-success-surface"],
    warningSurface: ["--color-background-warning-surface"],
    dangerSurface: ["--color-background-danger-surface"],
  }),
  diff: Object.freeze({
    addedText: [
      "--color-decoration-added",
      "--color-codex-git-added",
      "--vscode-gitDecoration-addedResourceForeground",
    ],
    deletedText: [
      "--color-decoration-deleted",
      "--color-codex-git-deleted",
      "--vscode-gitDecoration-deletedResourceForeground",
    ],
    modifiedText: [
      "--color-decoration-modified",
      "--vscode-gitDecoration-modifiedResourceForeground",
      "--vscode-gitDecoration-ignoredResourceForeground",
    ],
    unchangedText: ["--color-decoration-unchanged"],
    addedBackground: [
      "--color-editor-added",
      "--color-codex-diff-added",
      "--vscode-diffEditor-insertedLineBackground",
    ],
    deletedBackground: [
      "--color-editor-deleted",
      "--color-codex-diff-deleted",
      "--vscode-diffEditor-removedLineBackground",
    ],
    surface: ["--color-codex-diff-surface", "--color-token-diff-surface"],
  }),
  charts: Object.freeze({
    blue: ["--color-chart-blue", "--color-accent-blue", "--vscode-charts-blue", "--color-token-charts-blue"],
    green: ["--color-chart-green", "--color-accent-green", "--vscode-charts-green"],
    orange: ["--color-chart-orange", "--color-accent-orange", "--vscode-charts-orange"],
    purple: ["--color-chart-purple", "--color-accent-purple", "--vscode-charts-purple"],
    red: ["--color-chart-red", "--color-accent-red", "--vscode-charts-red"],
    yellow: ["--color-chart-yellow", "--color-accent-yellow", "--vscode-charts-yellow"],
  }),
  terminal: Object.freeze({
    foreground: ["--color-codex-terminal-foreground", "--vscode-terminal-foreground"],
    selection: [
      "--vscode-terminal-selectionBackground",
      "--vscode-terminal-inactiveSelectionBackground",
    ],
    black: ["--color-codex-terminal-ansi-black", "--vscode-terminal-ansiBlack"],
    red: ["--color-codex-terminal-ansi-red", "--vscode-terminal-ansiRed"],
    green: ["--color-codex-terminal-ansi-green", "--vscode-terminal-ansiGreen"],
    yellow: ["--color-codex-terminal-ansi-yellow", "--vscode-terminal-ansiYellow"],
    blue: ["--color-codex-terminal-ansi-blue", "--vscode-terminal-ansiBlue"],
    magenta: ["--color-codex-terminal-ansi-magenta", "--vscode-terminal-ansiMagenta"],
    cyan: ["--color-codex-terminal-ansi-cyan", "--vscode-terminal-ansiCyan"],
    white: ["--color-codex-terminal-ansi-white", "--vscode-terminal-ansiWhite"],
    brightBlack: ["--color-codex-terminal-ansi-bright-black", "--vscode-terminal-ansiBrightBlack"],
    brightRed: ["--color-codex-terminal-ansi-bright-red", "--vscode-terminal-ansiBrightRed"],
    brightGreen: ["--color-codex-terminal-ansi-bright-green", "--vscode-terminal-ansiBrightGreen"],
    brightYellow: ["--color-codex-terminal-ansi-bright-yellow", "--vscode-terminal-ansiBrightYellow"],
    brightBlue: ["--color-codex-terminal-ansi-bright-blue", "--vscode-terminal-ansiBrightBlue"],
    brightMagenta: ["--color-codex-terminal-ansi-bright-magenta", "--vscode-terminal-ansiBrightMagenta"],
    brightCyan: ["--color-codex-terminal-ansi-bright-cyan", "--vscode-terminal-ansiBrightCyan"],
    brightWhite: ["--color-codex-terminal-ansi-bright-white", "--vscode-terminal-ansiBrightWhite"],
  }),
  effects: Object.freeze({
    userPromptShadow: [],
  }),
});

export const THEME_COLOR_GROUPS = Object.freeze(
  Object.fromEntries(
    Object.entries(THEME_COLOR_TOKENS).map(([group, tokens]) => [
      group,
      Object.freeze(Object.keys(tokens)),
    ]),
  ),
);

export const THEME_COLOR_KEYS = Object.freeze(
  Object.entries(THEME_COLOR_GROUPS).flatMap(([group, keys]) =>
    keys.map((key) => `${group}.${key}`),
  ),
);

const DEFAULT_SCAN = Object.freeze({
  properties: DEFAULT_COLOR_PROPERTIES,
  maxElements: 2500,
  maxSamplesPerValue: 3,
});

const TITLEBAR_INSPECT = Object.freeze([
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
]);

const USER_PROMPT_INSPECT = Object.freeze([
  ...TITLEBAR_INSPECT,
  "box-shadow",
]);

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function validateColor(value, label) {
  requireString(value, label);
  if (!SAFE_COLOR_VALUE.test(value.trim())) {
    throw new TypeError(
      `${label} must be a CSS color such as #6e0002, red, rgb(...), or hsl(...).`,
    );
  }
}

export async function loadTheme(themePath = DEFAULT_THEME_PATH) {
  const resolvedPath = path.resolve(themePath);
  const source = await readFile(resolvedPath, "utf8");
  const theme = JSON.parse(source);
  validateTheme(theme);
  return theme;
}

export function validateTheme(theme) {
  if (!theme || typeof theme !== "object" || Array.isArray(theme)) {
    throw new TypeError("Theme config must be an object.");
  }
  if (theme.schemaVersion !== 4) {
    throw new TypeError("Theme config requires schemaVersion 4.");
  }

  requireString(theme.id, "Theme id");
  requireString(theme.name, "Theme name");
  if (!SAFE_ID.test(theme.id)) {
    throw new TypeError("Theme id may contain only letters, numbers, and dashes.");
  }
  if (theme.description !== undefined) {
    requireString(theme.description, "Theme description");
  }

  if (!theme.colors || typeof theme.colors !== "object" || Array.isArray(theme.colors)) {
    throw new TypeError("Theme config requires a colors object.");
  }

  const configuredGroups = Object.keys(theme.colors);
  const expectedGroups = Object.keys(THEME_COLOR_GROUPS);
  const missingGroups = expectedGroups.filter(
    (group) => !Object.hasOwn(theme.colors, group),
  );
  if (missingGroups.length > 0) {
    throw new TypeError(`Theme color groups are missing: ${missingGroups.join(", ")}`);
  }
  const unknownGroups = configuredGroups.filter(
    (group) => !Object.hasOwn(THEME_COLOR_GROUPS, group),
  );
  if (unknownGroups.length > 0) {
    throw new TypeError(`Unknown theme color groups: ${unknownGroups.join(", ")}`);
  }

  for (const [group, expectedKeys] of Object.entries(THEME_COLOR_GROUPS)) {
    const configured = theme.colors[group];
    if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
      throw new TypeError(`colors.${group} must be an object.`);
    }
    const configuredKeys = Object.keys(configured);
    const missingKeys = expectedKeys.filter(
      (key) => !Object.hasOwn(configured, key),
    );
    if (missingKeys.length > 0) {
      throw new TypeError(
        `Theme colors are missing: ${missingKeys.map((key) => `${group}.${key}`).join(", ")}`,
      );
    }
    const unknownKeys = configuredKeys.filter(
      (key) => !expectedKeys.includes(key),
    );
    if (unknownKeys.length > 0) {
      throw new TypeError(
        `Unknown theme colors: ${unknownKeys.map((key) => `${group}.${key}`).join(", ")}`,
      );
    }
    for (const key of expectedKeys) {
      validateColor(configured[key], `colors.${group}.${key}`);
    }
  }

  return theme;
}

function materializeTheme(theme) {
  validateTheme(theme);
  const { colors } = theme;
  const rootVariables = {};
  for (const [group, tokens] of Object.entries(THEME_COLOR_TOKENS)) {
    for (const [key, variables] of Object.entries(tokens)) {
      for (const variable of variables) {
        rootVariables[variable] = colors[group][key];
      }
    }
  }
  return {
    rootVariables,
    elements: [
      {
        id: "application-menu-titlebar",
        selector: '[class*="_ApplicationMenuTopBar_"]',
        styles: {
          "background-color": colors.surfaces.titleBarBackground,
          color: colors.text.titleBar,
        },
        inspect: TITLEBAR_INSPECT,
      },
      {
        id: "user-message-bubble",
        selector: "[data-user-message-bubble]",
        styles: {
          "background-color": colors.surfaces.userPromptBackground,
          color: colors.text.userPrompt,
          border: `1px solid ${colors.borders.userPrompt}`,
          "box-shadow": `0 6px 18px ${colors.effects.userPromptShadow}`,
        },
        variants: [
          {
            suffix: ":hover",
            styles: {
              "background-color": colors.surfaces.userPromptHover,
            },
          },
        ],
        inspect: USER_PROMPT_INSPECT,
      },
    ],
    scan: DEFAULT_SCAN,
  };
}

export function describeTheme(theme) {
  const materialized = materializeTheme(theme);
  return {
    schemaVersion: theme.schemaVersion,
    id: theme.id,
    name: theme.name,
    colorCount: THEME_COLOR_KEYS.length,
    colorGroupCount: Object.keys(THEME_COLOR_GROUPS).length,
    cssVariableCount: Object.keys(materialized.rootVariables).length,
    elementCount: materialized.elements.length,
    scanPropertyCount: materialized.scan.properties.length,
  };
}

function declarationBlock(styles) {
  return Object.entries(styles)
    .map(([property, value]) => {
      const important = /!important\s*$/i.test(value) ? "" : " !important";
      return `  ${property}: ${value}${important};`;
    })
    .join("\n");
}

export function compileThemeCss(theme) {
  const materialized = materializeTheme(theme);
  const blocks = [
    `:root {\n${declarationBlock(materialized.rootVariables)}\n}`,
  ];

  for (const element of materialized.elements) {
    blocks.push(`${element.selector} {\n${declarationBlock(element.styles)}\n}`);
    for (const variant of element.variants ?? []) {
      blocks.push(
        `${element.selector}${variant.suffix} {\n${declarationBlock(variant.styles)}\n}`,
      );
    }
  }

  // Expand the chat transcript to the available width while keeping responsive wrapping.
  blocks.push(`[class~="thread-scroll-container"] [class*="_transcriptContent_"] {\n  --thread-content-max-width: 100% !important;\n  --thread-body-max-width: 100% !important;\n  max-width: 100% !important;\n  min-width: 0;\n}`);

  return `${blocks.join("\n\n")}\n`;
}

function runtimePayload(theme) {
  const materialized = materializeTheme(theme);
  return {
    id: theme.id,
    css: compileThemeCss(theme),
    rootVariables: Object.keys(materialized.rootVariables),
    elements: materialized.elements.map((element) => ({
      id: element.id,
      selector: element.selector,
      inspect: element.inspect ?? DEFAULT_COLOR_PROPERTIES,
    })),
  };
}

function buildObservationExpression(theme, action, setup = "") {
  const payload = JSON.stringify(runtimePayload(theme));
  return `(() => {
    const theme = ${payload};
    ${setup}
    const describe = (node, properties, index) => {
      const computed = getComputedStyle(node);
      const values = {};
      for (const property of properties) {
        values[property] = computed.getPropertyValue(property).trim() || null;
      }
      return {
        index,
        tag: node.tagName.toLowerCase(),
        id: node.id || null,
        className: typeof node.className === "string" ? node.className : null,
        values
      };
    };
    const elements = theme.elements.map((rule) => {
      const nodes = Array.from(document.querySelectorAll(rule.selector));
      return {
        id: rule.id,
        selector: rule.selector,
        count: nodes.length,
        samples: nodes.slice(0, 3).map((node, index) => describe(node, rule.inspect, index))
      };
    });
    const rootComputed = getComputedStyle(document.documentElement);
    const rootVariables = {};
    for (const property of theme.rootVariables) {
      rootVariables[property] = rootComputed.getPropertyValue(property).trim() || null;
    }
    return {
      action: ${JSON.stringify(action)},
      url: location.href,
      title: document.title,
      stylePresent: Boolean(document.getElementById(theme.id)),
      elements,
      rootVariables
    };
  })()`;
}

export function buildApplyExpression(theme) {
  const setup = `
    const install = () => {
      if (!document.head) return false;
      let style = document.getElementById(theme.id);
      if (!style) {
        style = document.createElement("style");
        style.id = theme.id;
        style.dataset.chatgptThemeChanger = "true";
        document.head.appendChild(style);
      }
      style.textContent = theme.css;
      document.documentElement.dataset.chatgptThemeChanger = theme.id;
      return true;
    };
    const installed = install();
    if (!installed) {
      document.addEventListener("DOMContentLoaded", install, { once: true });
    }
  `;
  return buildObservationExpression(theme, "apply", setup);
}

export function buildInspectExpression(theme) {
  return buildObservationExpression(theme, "inspect");
}

export function buildStatusExpression(theme) {
  return buildObservationExpression(theme, "status");
}

export function buildRestoreExpression(theme) {
  const setup = `
    document.getElementById(theme.id)?.remove();
    if (document.documentElement.dataset.chatgptThemeChanger === theme.id) {
      delete document.documentElement.dataset.chatgptThemeChanger;
    }
  `;
  return buildObservationExpression(theme, "restore", setup);
}

export function buildScanExpression(theme) {
  validateTheme(theme);
  const scan = JSON.stringify(DEFAULT_SCAN);
  return `(() => {
    const scan = ${scan};
    const escape = (value) => globalThis.CSS?.escape
      ? globalThis.CSS.escape(value)
      : value.replace(/[^a-z0-9_-]/gi, "_");
    const hint = (node) => {
      if (node.id) return "#" + escape(node.id);
      for (const name of ["data-testid", "data-user-message-bubble", "role", "aria-label"]) {
        if (node.hasAttribute(name)) {
          const value = node.getAttribute(name);
          return value === "" ? "[" + name + "]" : "[" + name + "=\\\"" + value.slice(0, 80) + "\\\"]";
        }
      }
      const classes = typeof node.className === "string"
        ? node.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2)
        : [];
      return node.tagName.toLowerCase() + classes.map((name) => "." + escape(name)).join("");
    };
    const nodes = Array.from(document.querySelectorAll("*"))
      .filter((node) => {
        const computed = getComputedStyle(node);
        if (computed.display === "none" || computed.visibility === "hidden") return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .slice(0, scan.maxElements);
    const buckets = new Map();
    for (const node of nodes) {
      const computed = getComputedStyle(node);
      for (const property of scan.properties) {
        const value = computed.getPropertyValue(property).trim();
        if (!value) continue;
        const key = property + "\\u0000" + value;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { property, value, count: 0, samples: [] };
          buckets.set(key, bucket);
        }
        bucket.count += 1;
        if (bucket.samples.length < scan.maxSamplesPerValue) {
          bucket.samples.push({
            selector: hint(node),
            tag: node.tagName.toLowerCase()
          });
        }
      }
    }
    return {
      action: "scan",
      url: location.href,
      title: document.title,
      scannedElementCount: nodes.length,
      colors: Array.from(buckets.values()).sort((a, b) => b.count - a.count)
    };
  })()`;
}
