// Presentation-only CII Prefix mask for ChatGPT user message bubbles.
// The wire request is handled by breakpoint.mjs; never rewrite an app-owned
// ProseMirror editor, React state, or a user message's original DOM text.
export function installCiiDisplayMask(prefixInput) {
  const prefixValue=String(prefixInput||"");
  if(!prefixValue.trim())return "SPARK_CII_DISPLAY_EMPTY_PREFIX";
  const eligible=()=>(
    location.protocol==="app:" && location.hostname==="-" &&
      location.pathname==="/index.html") ||
    (location.origin==="https://chatgpt.com" &&
      !/^\/(auth|login|verify|oauth|sso|mfa|challenge|account|settings|billing|checkout|security)(\/|$)/i.test(location.pathname));
  if(!eligible())return "SPARK_CII_DISPLAY_UNSUPPORTED_PAGE";
  const version="CII_DISPLAY_MASK_V1";
  const old=window.__sparkCiiDisplayMask;
  if(old?.getState?.().enabled===true){
    if(old.getState().version===version) {
      old.configure(prefixValue);
      return "SPARK_CII_DISPLAY_ALREADY";
    }
    old.disable?.();
    if(window.__sparkCiiDisplayMask)
      return "SPARK_CII_DISPLAY_PREVIOUS_NOT_REMOVABLE";
  }
  let enabled=true, masked=0, errors=0, unsupported=0, scans=0, queued=false;
  let prefix=prefixValue;
  const prefixes=[prefixValue];
  const styleId="spark-cii-display-mask-v1";
  const marker="spark-cii-display-projection";
  const richMarker="spark-cii-rich-prefix-hidden";
  const sourceSelector="[class~='group/user-message'],[data-message-author-role='user'],[data-role='user']";
  const leafSelector="[class~='whitespace-pre-wrap'],p";
  let lastScanAt=null;
  function visibleText(raw){
    if(typeof raw!=="string")return null;
    for(const entry of prefixes){
      if(raw.startsWith(entry+"\n\n"))return raw.slice(entry.length+2);
      if(raw===entry)return "";
    }
    return null;
  }
  function projectText(raw){
    return visibleText(raw)??raw;
  }
  function addStyle(){
    if(document.getElementById(styleId))return;
    const head=document.head||document.documentElement;
    if(!head)return;
    const style=document.createElement("style");
    style.id=styleId;
    style.textContent=[
      "."+marker+"{font-size:0!important;line-height:0!important;letter-spacing:0!important;}",
      "."+marker+"::after{content:attr(data-spark-cii-visible)!important;",
      "display:block!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;",
      "font-family:inherit!important;",
      "font-size:var(--spark-cii-display-font-size,16px)!important;",
      "line-height:var(--spark-cii-display-line-height,24px)!important;",
      "color:var(--spark-cii-display-color,inherit)!important;}",
      "."+richMarker+"{display:none!important;}"
    ].join("");
    head.appendChild(style);
  }
  function clear(node) {
    if(!node.classList?.contains(marker))return;
    node.classList.remove(marker);
    node.removeAttribute("data-spark-cii-visible");
    for(const v of ["font-size","line-height","color"])
      node.style.removeProperty("--spark-cii-display-"+v);
  }
  // Legacy Markdown user turns can render Prefix as a standalone P
  // containing text/BR or STRONG/BR nodes. Hide only the exact Prefix P,
  // preserving the following authored Markdown nodes and attachments.
  function maskRich(root) {
    if(!root?.isConnected || root.isContentEditable ||
       !root.classList?.contains("rich-text-user-turn") ||
       !root.closest(sourceSelector) ||
       root.closest("form,[data-message-author-role='assistant'],[data-role='assistant']"))return;
    const first=root.firstElementChild;
    if(first?.tagName!=="P" || root.children.length<2 ||
       !Array.from(root.children).slice(1).some(n=>String(n.textContent||"").trim()))return;
    const pieces=Array.from(first.childNodes).filter(n=>
      n.nodeType===1 || String(n.textContent||"").trim());
    const clean=v=>String(v||"").replace(/\u00a0/g," ");
    let matched=false;
    for(const candidate of prefixes) {
      const lines=candidate.split("\n");
      if(!lines.length||lines.length>16||lines.some(line=>!line.trim()))continue;
      const bold=lines.every(line=>/^\*\*[^\n]+\*\*$/.test(line));
      const expected=bold?lines.map(line=>line.slice(2,-2)):lines;
      if(!bold&&lines.some(line=>/^\*\*.*\*\*$/.test(line)))continue;
      if(!bold&&pieces.length===1&&pieces[0].nodeType===3)
        matched=clean(pieces[0].textContent).replace(/\r\n?/g,"\n")===expected.join("\n");
      else if(pieces.length===expected.length*2-1){
        const textNodes=pieces.filter((_,i)=>i%2===0);
        const allText=textNodes.every(n=>n.nodeType===3);
        const allBold=textNodes.every(n=>n.tagName==="STRONG");
        matched=(allText||allBold)&&pieces.every((n,i)=>
          i%2?n.tagName==="BR":clean(n.textContent)===expected[i/2]);
      }
      if(matched)break;
    }
    if(matched){
      if(!first.classList.contains(richMarker)){
        first.classList.add(richMarker);masked++;
      }
    }else if(first.classList.contains(richMarker))first.classList.remove(richMarker);
  }
  function scan() {
    queued=false;
    if(!enabled||!eligible()||!document.body)return;
    scans++;
    lastScanAt=new Date().toISOString();
    addStyle();
    for(const root of document.querySelectorAll(sourceSelector)){
      // Some app versions nest a second user turn inside the outer user turn.
      // Match only text leaves; never hide containers holding images/attachments.
      for(const leaf of root.querySelectorAll(leafSelector)){
        if(!leaf.isConnected||leaf.isContentEditable||
           leaf.closest("form,[contenteditable='true'],[data-message-author-role='assistant'],[data-role='assistant']") ||
           leaf.childElementCount>0)continue;
        const raw=leaf.textContent||"";
        const visible=visibleText(raw);
        if(visible===null){
          if(leaf.classList.contains(marker))clear(leaf);
          continue;
        }
        try{
          if(!leaf.classList.contains(marker)){
            const style=getComputedStyle(leaf);
            leaf.style.setProperty("--spark-cii-display-font-size",style.fontSize||"16px");
            leaf.style.setProperty("--spark-cii-display-line-height",style.lineHeight==="normal"?"normal":(style.lineHeight||"24px"));
            leaf.style.setProperty("--spark-cii-display-color",style.color||"inherit");
            leaf.classList.add(marker);
            masked++;
          }
          if(leaf.getAttribute("data-spark-cii-visible")!==visible)
            leaf.setAttribute("data-spark-cii-visible",visible);
        }catch{errors++}
      }
    }
    for(const root of document.querySelectorAll(".rich-text-user-turn"))
      maskRich(root);
  }
  function schedule() {
    if(queued||!enabled)return;
    queued=true;
    queueMicrotask(scan);
  }
  const observer=typeof MutationObserver==="function"?
    new MutationObserver(schedule):null;
  function startObservation(){
    const root=document.documentElement||document.body;
    if(root)observer?.observe(root,{childList:true,subtree:true,characterData:true});
    scan();
  }
  startObservation();
  if(!document.documentElement)
    window.addEventListener("DOMContentLoaded",startObservation,{once:true});
  window.__sparkCiiDisplayMask={
    configure(value){
      if(!enabled)return false;
      const next=String(value||"");
      if(!next.trim())return false;
      prefix=next;
      if(!prefixes.includes(next)){
        prefixes.unshift(next);
        if(prefixes.length>8)prefixes.pop();
      }
      schedule();
      return true;
    },
    projectText,
    refresh:scan,
    getState(){
      return {version,enabled,masked,errors,unsupported,scans,lastScanAt};
    },
    disable(){
      if(!enabled)return;
      enabled=false;
      observer?.disconnect();
      for(const node of document.querySelectorAll("."+marker))clear(node);
      for(const node of document.querySelectorAll("."+richMarker))
        node.classList.remove(richMarker);
      document.getElementById(styleId)?.remove();
      if(window.__sparkCiiDisplayMask===this)
        delete window.__sparkCiiDisplayMask;
    }
  };
  return "SPARK_CII_DISPLAY_INSTALLED";
}

export function buildDisplayMaskExpression(prefix) {
  if(typeof prefix!=="string"||!prefix.trim())
    throw new TypeError("CII display prefix is required.");
  return "("+installCiiDisplayMask.toString()+")("+JSON.stringify(prefix)+")";
}

export function buildDisableDisplayMaskExpression() {
  return "(()=>{const mask=window.__sparkCiiDisplayMask;" +
    "if(!mask)return 'NOT_INSTALLED';mask.disable();" +
    "return window.__sparkCiiDisplayMask?'DISABLE_FAILED':'DISABLED'})()";
}
