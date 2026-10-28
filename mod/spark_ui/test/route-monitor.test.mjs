import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { newRoute, extractRequest, extractResponseEvent, parseEventText, routeVerdict, safeHeaders, safeUrl } from "../src/route-metadata.mjs";
import { RouteCollector, isChatGenerationRequest } from "../src/route-collector.mjs";
import { buildRouteOverlayExpression, chooseRouteDockLayout } from "../src/route-overlay.mjs";

test("request/response routing and effort provenance", () => {
  const r = newRoute();
  assert.equal(extractRequest(JSON.stringify({ model: "gpt-test", thinking_effort: "high", messages: [{content:"SECRET"}] }), r), true);
  extractResponseEvent({ resolved_model_slug: "gpt-test", type: "server_ste_metadata", metadata: { model_slug:"gpt-test", cluster_region:"eu", authorization:"SECRET", thinking_effort:"high" }}, r);
  assert.equal(routeVerdict(r), "MATCH");
  assert.equal(r.requestedEffort, "high");
  assert.equal(r.serverEffort, "high");
  assert.equal(r.metadata.authorization, undefined);
  assert.equal(JSON.stringify(r).includes("SECRET"), false);
});

test("unknown effort not guessed and auto routing not a mismatch", () => {
  const r = newRoute();
  extractRequest('{"model":"auto"}',r);
  extractResponseEvent({resolved_model_slug:"gpt-test"},r);
  assert.equal(r.resolvedEffort,null);
  assert.equal(routeVerdict(r),"AUTO_ROUTED");
});

test("SSE, sensitive headers, URL sanitization", () => {
  const r=newRoute();
  parseEventText('event: server_ste_metadata\ndata: {"type":"server_ste_metadata","metadata":{"model_slug":"gpt-test"}}\n\n',r);
  assert.equal(r.serverModel,"gpt-test");
  assert.deepEqual(safeHeaders({Authorization:"secret",Cookie:"secret", "Content-Type":"text/event-stream", "X-Api-Key":"secret"}), {"content-type":"text/event-stream"});
  assert.equal(safeUrl("https://chatgpt.com/backend-api/conversation?access_token=secret"),"https://chatgpt.com/backend-api/conversation");
});

test("timestamps, bytes, status and failures", () => {
  const c=new RouteCollector();
  c.handle("Network.requestWillBeSent",{requestId:"1",request:{url:"https://chatgpt.com/c?secret=1",method:"POST",postData:'{"model":"gpt-6","reasoning_effort":"medium"}'},wallTime:1000,timestamp:1,type:"Fetch"});
  c.handle("Network.responseReceived",{requestId:"1",response:{status:200,mimeType:"text/event-stream",headers:{"Content-Type":"text/event-stream"}}});
  c.handle("Network.dataReceived",{requestId:"1",dataLength:100,encodedDataLength:80});
  c.handle("Network.loadingFinished",{requestId:"1",timestamp:2,encodedDataLength:95});
  const r=c.snapshot().completed[0];
  assert.equal(r.wallTimeMs,1000);
  assert.equal(r.responseBytes,95);
  assert.equal(r.decodedDataLength,100);
  assert.equal(r.route.requestedModel,"gpt-6");
  assert.equal(r.url,"https://chatgpt.com/c");
  assert.equal(JSON.stringify(r).includes("secret"),false);
  c.handle("Network.loadingFailed",{requestId:"2",errorText:"net::ERR_FAILED",canceled:true});
  assert.equal(c.snapshot().metrics.failures,1);
});

test("overlay contains metadata but no executable raw content", () => {
  const c=new RouteCollector();
  const js=buildRouteOverlayExpression(c.snapshot());
  assert.doesNotThrow(()=>new Function(js));
});

test("wide and medium windows reserve a separate route monitor lane", () => {
  for (const [viewport, mainLeft, zoom] of [[2218, 449, 1.2], [1504, 449, 1.2]]) {
    const layout=chooseRouteDockLayout(viewport, mainLeft, zoom);
    assert.equal(layout.mode, "dock");
    assert.ok(layout.width >= 280 && layout.width <= 420);
    assert.ok(viewport-mainLeft-layout.width-28 >= 620);
    assert.ok(layout.reserve*zoom >= layout.width+28);
  }
});

test("narrow windows collapse the monitor into a rail or hide it", () => {
  const rail = chooseRouteDockLayout(1220, 449, 1.2);
  assert.equal(rail.mode, "rail");
  assert.equal(rail.width, 12);
  assert.ok(rail.reserve * 1.2 >= 24);
  assert.equal(chooseRouteDockLayout(800, 449, 1.2).mode, "hidden");
  const js=buildRouteOverlayExpression(new RouteCollector().snapshot());
  assert.match(js,/data-spark-route-original-margin/);
  assert.match(js,/document.querySelectorAll\("main"\)/);
  assert.match(js,/dock-could-overlap-chat/);
  assert.match(js,/panelTop/);
  assert.match(js,/data-route-restore/);
  assert.match(js,/__sparkRouteMonitorMinimized/);
  assert.match(js,/width:12px;height:54px/);
  assert.match(js,/title.textContent = compact \? ""/);
  assert.match(js,/restore.textContent = compact \? ""/);
  assert.match(js,/data-route-metadata-inventory/);
  assert.match(js,/data-route-quota-bar/);
  assert.match(js,/Codex Desktop \/wham\/usage/);
  assert.match(js,/SERVER → CLIENT/);
  assert.match(js,/CLIENT → SERVER/);
  assert.doesNotMatch(js,/position:fixed;right:12px;top:52px/);
  assert.doesNotMatch(js,/position:fixed;right:12px;bottom:12px/);
});

test("generation requests are distinguished from unrelated traffic", () => {
  assert.equal(isChatGenerationRequest(
    "https://chatgpt.com/backend-api/conversation", "POST"), true);
  assert.equal(isChatGenerationRequest(
    "https://chatgpt.com/backend-api/conversation", "GET"), false);
  assert.equal(isChatGenerationRequest(
    "app://-/index.html", "GET"), false);
  const c = new RouteCollector();
  c.capture.state = "connected";
  c.capture.attachedTargets = 2;
  c.handle("Network.requestWillBeSent", {
    requestId: "local", wallTime: 1000, timestamp: 1,
    request: { url: "app://-/index.html", method: "GET" },
  });
  assert.equal(c.snapshot().metrics.chatRequests, 0);
  assert.equal(c.snapshot().metrics.modelEvidence, 0);
  assert.equal(c.snapshot().capture.attachedTargets, 2);
});

test("chunked SSE streaming extracts metadata without recording chat text", () => {
  const c = new RouteCollector();
  const id = "stream-1";
  c.handle("Network.requestWillBeSent", {
    requestId: id, wallTime: 1000, timestamp: 1,
    request: {
      url: "https://chatgpt.com/backend-api/conversation",
      method: "POST", postData: '{"model":"gpt-test","reasoning_effort":"high","messages":[{"text":"PRIVATE_MSG"}]}',
    },
  });
  c.handle("Network.responseReceived", {
    requestId: id, response: { status: 200, mimeType: "text/event-stream", headers: { "Content-Type": "text/event-stream" } },
  });
  const event = 'data: {"resolved_model_slug":"gpt-test","type":"server_ste_metadata","metadata":{"model_slug":"gpt-test","thinking_effort":"high","content":"PRIVATE_RESPONSE"}}\n\n';
  assert.equal(c.ingestStream(id, Buffer.from(event.slice(0, 13)).toString("base64")), 0);
  assert.equal(c.ingestStream(id, Buffer.from(event.slice(13)).toString("base64")), 1);
  const rec = c.snapshot().active.find(x => x.id === id);
  assert.equal(rec.route.resolvedModel, "gpt-test");
  assert.equal(rec.route.serverModel, "gpt-test");
  assert.equal(rec.route.serverEffort, "high");
  assert.equal(rec.route.requestedModel, "gpt-test");
  assert.equal(rec.verdict, "MATCH");
  assert.equal(JSON.stringify(rec).includes("PRIVATE_MSG"), false);
  assert.equal(JSON.stringify(rec).includes("PRIVATE_RESPONSE"), false);
  assert.equal(c.snapshot().metrics.sseEvents, 1);
  c.handle("Network.loadingFinished", {requestId:id,timestamp:2.5,encodedDataLength:950});
  assert.equal(c.snapshot().completed[0].responseBytes, 950);
});

test("pre-existing WebSocket frames are not presented as complete HTTP requests", () => {
  const c = new RouteCollector();
  c.handle("Network.webSocketFrameSent", {
    requestId: "ws-1", response: {
      opcode: 1, payloadData: '{"payload":{"parameters":{"model":"gpt-6","reasoning.effort":"extra_high"},"messages":[{"text":"SENSITIVE"}]}}',
    },
  });
  const record = c.snapshot().active[0];
  assert.equal(record.startedAt, null);
  assert.equal(record.method, "WS (pre-existing)");
  assert.equal(record.resourceType, "WebSocket");
  assert.equal(record.route.requestedModel, "gpt-6");
  assert.equal(record.route.requestedEffort, "extra_high");
  assert.equal(record.route.fieldSources.requestedModel, "websocket-sent.payload.parameters.model");
  assert.equal(c.snapshot().metrics.orphanFrames, 1);
  assert.equal(JSON.stringify(record).includes("SENSITIVE"), false);
});

test("path identifiers, URL queries and private headers stay out of metadata", () => {
  assert.equal(safeUrl("https://chatgpt.com/c/01234567-89ab-cdef-0123-abcdef012345?secret=1"),
    "https://chatgpt.com/c/:id");
  assert.equal(safeUrl("app://-/index.html?debug=private"), "app://-/index.html");
  assert.deepEqual(safeHeaders({cookie:"secret",Authorization:"secret","content-type":"application/json","X-Api-Key":"secret"}),
    {"content-type":"application/json"});
  const c = new RouteCollector();
  const js = buildRouteOverlayExpression(c.snapshot());
  assert.match(js, /Response metadata uses the current rendered assistant turn/);
  assert.match(js, /RESPONSE MODEL/);
  assert.match(js, /NOT OBSERVED/);
  assert.doesNotMatch(js, /PRIVATE_MSG/);
});

test("server STE metadata inventories all non-sensitive names and types without unsafe values", () => {
  const route = newRoute();
  extractResponseEvent({
    type: "server_ste_metadata",
    metadata: {
      model_slug: "gpt-6-thinking",
      thinking_effort: "max",
      hidden_future_type: "A PRIVATE VALUE WITH SPACES",
      future_duration_ms: 921,
      auth_token: "SECRET_TOKEN",
      request_id: "PRIVATE-REQ-123456",
      account_id: 123456789,
    },
  }, route, "ws-received");
  assert.equal(route.metadata.thinking_effort, "max");
  assert.equal(route.metadataKeyTypes.thinking_effort, "string");
  assert.equal(route.metadataSources.future_duration_ms,
    "ws-received:metadata.future_duration_ms");
  assert.equal(route.metadataKeyTypes.hidden_future_type, "string");
  assert.equal(route.metadata.hidden_future_type, undefined);
  assert.equal(route.metadataKeyTypes.auth_token, undefined);
  assert.equal(route.metadataKeyTypes.request_id, "string");
  assert.equal(route.metadata.request_id, undefined);
  assert.equal(route.metadata.account_id, undefined);
  assert.equal(JSON.stringify(route).includes("PRIVATE VALUE"), false);
  assert.equal(JSON.stringify(route).includes("SECRET_TOKEN"), false);
  assert.equal(JSON.stringify(route).includes("PRIVATE-REQ-123456"), false);
  assert.equal(JSON.stringify(route).includes("123456789"), false);
});

test("metadata and effort audit renders current, previous-final and unlinked source separately", () => {
  const expression = buildRouteOverlayExpression(new RouteCollector().snapshot());
  assert.doesNotThrow(() => new Function(expression));
  assert.match(expression, /data-route-effort-audit/);
  assert.match(expression, /LATEST COMPLETED FINAL metadata/);
  assert.match(expression, /LAST EFFORT SOURCE/);
  assert.match(expression, /INDEPENDENT EFFORT/);
  assert.match(expression, /metadataKeyTypes/);
  assert.match(expression, /WITHHELD: metadata key\/type observed/);
});

test("UI baseline history uses bounded current/previous slots, without new folders",async()=>{
  const script=await readFile(new URL("../script/start-chatgpt-ui.ps1",import.meta.url),"utf8");
  assert.match(script,/baseline-current\.json/);
  assert.match(script,/baseline-previous\.json/);
  assert.match(script,/The approved operational directory must already exist/);
  assert.doesNotMatch(script,/Join-Path \$RuntimeDirectory "baseline-\$\(/);
  assert.doesNotMatch(script,/New-Item -ItemType Directory -Path \$RuntimeDirectory -Force/);
});

test("outgoing panel distinguishes local CII insertion, replay and unobserved server egress", () => {
  const expression = buildRouteOverlayExpression(new RouteCollector().snapshot());
  assert.doesNotThrow(() => new Function(expression));
  for (const field of [
    "편집기 선택","Prefix 계획","Prefix 삽입","삽입 직후",
    "140ms 재검증","Send 버튼","CII 결과","최근 실패","CII 추적"
  ]) assert.ok(expression.includes(field), "missing CII stage row " + field);
  assert.match(expression, /ciiState\.lastAttempt/);
  assert.match(expression, /LOCAL_SEND_ONLY/);
  assert.match(expression, /실제 서버 수신 미확인/);
  assert.match(expression, /NOT OBSERVED/);
});

test("egress monitor displays fail-closed gate and distinguishes callframe from server",()=>{
  const expression=buildRouteOverlayExpression(new RouteCollector().snapshot());
  assert.doesNotThrow(()=>new Function(expression));
  for(const field of ["EGRESS_REQUEST_BOUNDARY","__sparkCiiGate",
    "__sparkCiiBreakpointState","Egress Gate","Egress 경계","Prefix 결합",
    "2B CII Egress","IPC/TLS/서버 수신 NOT OBSERVED"])
    assert.ok(expression.includes(field),field);
  assert.ok(!expression.includes("EGRESS_SERVER_RECEIVED_PASS"));
});

test("route monitor projects the user bubble through CII display mask without altering wire evidence",()=>{
  const expression=buildRouteOverlayExpression(new RouteCollector().snapshot());
  assert.doesNotThrow(()=>new Function(expression));
  assert.match(expression,/__sparkCiiDisplayMask\?\.projectText/);
  assert.ok(expression.includes("말풍선 Prefix 숨김"));
  assert.ok(expression.includes("data-route-rendered-message"));
  assert.ok(expression.includes("data-route-outbound-message"));
});

test("minimized route panel destroys stale user-body nodes instead of retaining hidden Prefix",()=>{
  const expression=buildRouteOverlayExpression(new RouteCollector().snapshot());
  assert.doesNotThrow(()=>new Function(expression));
  assert.ok(expression.includes("details.hidden && details.childElementCount"));
  assert.ok(expression.includes("details.replaceChildren()"));
});
