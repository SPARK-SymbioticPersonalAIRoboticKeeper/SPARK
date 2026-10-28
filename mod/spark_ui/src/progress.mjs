export const PROGRESS_ROOT_ID = "spark-progress-overlay";
export const PROGRESS_STYLE_ID = "spark-progress-overlay-style";

function safeSnapshot(snapshot = {}) {
  const activity = snapshot?.activity && typeof snapshot.activity === "object"
    ? snapshot.activity
    : {};
  return {
    checkedAt: typeof snapshot?.checkedAt === "string" ? snapshot.checkedAt : null,
    transportError: typeof snapshot?.transportError === "string" ? snapshot.transportError : null,
    activity: {
      active: activity.active ?? null,
      pendingUncertainMutation: activity.pendingUncertainMutation ?? null,
      last: activity.last ?? null,
    },
  };
}

// No left-side DOM widget: data collection continues into the unified panel.

export function buildProgressExpression(_theme, snapshot = {}) {
  const payload = JSON.stringify({
    rootId: PROGRESS_ROOT_ID,
    styleId: PROGRESS_STYLE_ID,
    snapshot: safeSnapshot(snapshot),
  });

  return `(async () => {
    const payload = ${payload};
    const now = Date.now();
    const visible = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const controls = Array.from(document.querySelectorAll("button,[role=button]"));
    const stopControl = controls.find((node) => {
      if (!visible(node)) return false;
      const label = [node.getAttribute("aria-label"), node.getAttribute("title"), node.textContent]
        .filter(Boolean).join(" ").trim().toLowerCase();
      return /(^|\\s)(stop|cancel)(\\s|$)/.test(label) && !/stop sharing/.test(label);
    });
    const browserState = globalThis.__sparkProgressState ??= {
      brainStartedAt: null,
      usage: { data: null, fetchedAt: 0, inFlight: null, error: null },
    };
    if (!browserState.usage) {
      browserState.usage = { data: null, fetchedAt: 0, inFlight: null, error: null };
    }
    const brainWorking = Boolean(stopControl);
    if (brainWorking && !browserState.brainStartedAt) browserState.brainStartedAt = now;
    if (!brainWorking) browserState.brainStartedAt = null;
    const brainElapsedMs = browserState.brainStartedAt ? now - browserState.brainStartedAt : 0;
    browserState.brainWorking = brainWorking;
    browserState.brainElapsedMs = brainElapsedMs;
    const parseUsageWindow = (windowValue) => {
      if (!windowValue) return null;
      const rawUsed = windowValue.used_percent;
      // Missing/invalid usage is unknown, not 0%. A genuine 0 remains valid.
      const number = rawUsed == null || rawUsed === "" ? null : Number(rawUsed);
      const usedPercent = number !== null && Number.isFinite(number) &&
        number >= 0 && number <= 100 ? number : null;
      const rawMinutes = windowValue.limit_window_seconds == null ? null :
        Number(windowValue.limit_window_seconds) / 60;
      const reset = windowValue.reset_at == null ? null : Number(windowValue.reset_at);
      return {
        usedPercent,
        remainingPercent: usedPercent === null ? null : 100 - usedPercent,
        windowMinutes: rawMinutes !== null && Number.isFinite(rawMinutes) &&
          rawMinutes > 0 ? rawMinutes : null,
        resetAt: Number.isFinite(reset) && reset > 0 ? reset : null,
      };
    };
    const usageState = browserState.usage;
    const refreshUsage = async () => {
      try {
        const moduleUrl = Array.from(document.querySelectorAll('script[src],link[rel="modulepreload"],link[rel="preload"]'))
          .map((node) => node.src || node.href)
          .find((url) => /\\/assets\\/app-shared-[^/]+\\.js(?:$|\\?)/.test(url || ""));
        if (!moduleUrl) throw new Error("app-shared module not found");
        const appModule = await import(moduleUrl);
        const client = Object.values(appModule).find((candidate) => {
          if (!candidate || typeof candidate !== "object") return false;
          if (typeof candidate.safeGet !== "function" || typeof candidate.safePost !== "function" || typeof candidate.safeDelete !== "function") return false;
          if (typeof candidate.getRequestTarget !== "function") return false;
          try {
            const target = candidate.getRequestTarget("/wham/usage");
            return target?.url === "/wham/usage" && target?.headers?.originator === "Codex Desktop";
          } catch {
            return false;
          }
        });
        if (!client) throw new Error("authenticated ChatGPT request client not found");
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("usage request timeout")), 2500));
        const response = await Promise.race([client.safeGet("/wham/usage"), timeout]);
        const rateLimit = response?.rate_limit ?? null;
        if (!rateLimit || typeof rateLimit !== "object") {
          throw new Error("Codex usage rate_limit missing");
        }
        const additional = Array.isArray(response?.additional_rate_limits) ?
          response.additional_rate_limits.slice(0, 8).map((item) => ({
            name: typeof item?.limit_name === "string" &&
              /^[a-z0-9 ._+-]{1,60}$/i.test(item.limit_name) ?
              item.limit_name : "Additional limit",
            primary: parseUsageWindow(item?.rate_limit?.primary_window ??
              item?.primary_window),
            secondary: parseUsageWindow(item?.rate_limit?.secondary_window ??
              item?.secondary_window),
          })) : [];
        usageState.data = {
          source: "Codex Desktop /wham/usage",
          planType: typeof response?.plan_type === "string" ?
            response.plan_type.slice(0, 48) : null,
          primary: parseUsageWindow(rateLimit.primary_window),
          secondary: parseUsageWindow(rateLimit.secondary_window),
          limitReached: typeof rateLimit.limit_reached === "boolean" ?
            rateLimit.limit_reached : null,
          additional,
        };
        usageState.lastSuccessAt = Date.now();
        usageState.fetchedAt = Date.now();
        usageState.error = null;
      } catch (error) {
        usageState.error = error instanceof Error ? error.message : String(error);
        usageState.fetchedAt = Date.now();
      } finally {
        usageState.inFlight = null;
      }
    };
    if (!usageState.inFlight && (usageState.fetchedAt === 0 || now - usageState.fetchedAt >= 30000)) {
      usageState.inFlight = refreshUsage();
    }
    if (!usageState.data && usageState.inFlight) {
      await usageState.inFlight;
    }

    // Legacy 52px left usage widget is retired. Keep authenticated usage
    // polling in the desktop app, but present its data only in Route Monitor.
    document.getElementById(payload.rootId)?.remove();
    document.getElementById(payload.styleId)?.remove();
    browserState.transport = payload.snapshot;
    const usage = usageState.data;
    return {
      rootPresent: false, retiredLeftWidget: true,
      sparkState: payload.snapshot.activity?.active ? "active" :
        payload.snapshot.activity?.pendingUncertainMutation ? "uncertain" :
          payload.snapshot.transportError ? "offline" : "idle",
      usageAvailable: Boolean(usage?.primary || usage?.secondary),
      usagePrimaryRemaining: usage?.primary?.remainingPercent ?? null,
      usageSecondaryRemaining: usage?.secondary?.remainingPercent ?? null,
      usagePlanType: usage?.planType ?? null,
      usageSource: usage?.source ?? null,
      brainWorking,
      usageUpdatedAt: usageState.lastSuccessAt ?
        new Date(usageState.lastSuccessAt).toISOString() : null,
      usageError: usageState.error,
    };
  })()`;
}

export function buildProgressRestoreExpression() {
  return `(() => {
    document.getElementById(${JSON.stringify(PROGRESS_ROOT_ID)})?.remove();
    document.getElementById(${JSON.stringify(PROGRESS_STYLE_ID)})?.remove();
    delete globalThis.__sparkProgressState;
    return { restored: true };
  })()`;
}
