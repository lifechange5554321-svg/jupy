import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { applyBackspacePair, applyEnter, applyPair, escapeHtml, guideDepths, highlightPython, leadingColumns, wordKind, wordSuggestions } from "./logic";
import { bindSuggest } from "./suggest-bridge";

export type EditorMenuInfo = {
  x: number;
  y: number;
  start: number;
  end: number;
  value: string;
};

type Suggest = { x: number; y: number; from: number; prefix: string; items: string[]; index: number };

type Props = {
  value: string;
  readOnly: boolean;
  fontSize: number;
  wrap: boolean;
  indentGuides: boolean;
  plain?: boolean;
  rtl?: boolean;
  onChange: (value: string) => void;
  onFocus: (el: HTMLTextAreaElement) => void;
  onBlur: () => void;
  onMenu: (info: EditorMenuInfo) => void;
};

export function CodeEditor({
  value,
  readOnly,
  fontSize,
  wrap,
  indentGuides,
  plain = false,
  rtl = false,
  onChange,
  onFocus,
  onBlur,
  onMenu,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutRef = useRef<HTMLDivElement>(null);
  const hlRef = useRef<HTMLPreElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<number | null>(null);
  const menuAt = useRef(0);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [activeLevel, setActiveLevel] = useState(0);
  const suggestRef = useRef<Suggest | null>(null);
  suggestRef.current = suggest;
  const apiRef = useRef<{
    move: (dir: 1 | -1) => boolean;
    accept: () => boolean;
    cancel: () => boolean;
  }>({
    move: () => false,
    accept: () => false,
    cancel: () => false,
  });
  apiRef.current.move = (dir) => {
    const box = suggestRef.current;
    if (!box) return false;
    setSuggest({ ...box, index: (box.index + dir + box.items.length) % box.items.length });
    return true;
  };
  apiRef.current.accept = () => {
    const box = suggestRef.current;
    const item = box?.items[box.index];
    if (!box || !item) return false;
    acceptSuggest(item);
    return true;
  };
  apiRef.current.cancel = () => {
    if (!suggestRef.current) return false;
    setSuggest(null);
    return true;
  };

  useEffect(() => {
    if (!suggest) return;
    bindSuggest({
      move: (dir) => apiRef.current.move(dir),
      accept: () => apiRef.current.accept(),
      cancel: () => apiRef.current.cancel(),
    });
    return () => bindSuggest(null);
  }, [!!suggest]);

  useEffect(() => {
    document.querySelector(".suggest button.on")?.scrollIntoView({ block: "nearest" });
  }, [suggest?.index]);

  const lineCount = Math.max(1, value.split("\n").length);
  const lh = Math.round(fontSize * 1.55);
  const depths = indentGuides ? guideDepths(value) : [];

  function syncScroll() {
    const ta = taRef.current;
    if (!ta) return;
    if (gutRef.current) gutRef.current.style.transform = `translateY(${-ta.scrollTop}px)`;
    const shift = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    if (hlRef.current) hlRef.current.style.transform = shift;
    if (guideRef.current) guideRef.current.style.transform = shift;
    const box = suggestRef.current;
    if (box) {
      const spot = placeSuggest(ta, ta.selectionStart ?? 0, box.prefix.length, box.items.length);
      if (!spot) setSuggest(null);
      else if (spot.x !== box.x || spot.y !== box.y) setSuggest({ ...box, x: spot.x, y: spot.y });
    }
  }

  useEffect(() => {
    const ta = taRef.current;
    if (!ta || caretRef.current == null) return;
    const c = caretRef.current;
    caretRef.current = null;
    ta.selectionStart = ta.selectionEnd = c;
  }, [value]);

  function markActive(ta: HTMLTextAreaElement) {
    const pos = ta.selectionStart ?? 0;
    const line = ta.value.slice(0, pos).split("\n").pop() ?? "";
    setActiveLevel(Math.floor(leadingColumns(line) / 4));
  }

  function caretPoint(ta: HTMLTextAreaElement) {
    const caret = ta.selectionStart ?? 0;
    const upto = ta.value.slice(0, caret).split("\n");
    const col = upto[upto.length - 1]?.length ?? 0;
    const row = upto.length - 1;
    const rect = ta.getBoundingClientRect();
    const ch = fontSize * 0.62;
    return {
      x: rect.left + 10 + col * ch - ta.scrollLeft,
      y: rect.top + 8 + row * lh - ta.scrollTop,
    };
  }

  function openMenu(x: number, y: number) {
    const ta = taRef.current;
    if (!ta) return;
    const now = Date.now();
    if (now - menuAt.current < 350) return;
    menuAt.current = now;
    setSuggest(null);
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const pt = caretPoint(ta);
    onMenu({ x: pt.x || x, y: (pt.y || y) + lh, start, end, value: ta.value });
  }

  function commit(next: string, caret: number) {
    caretRef.current = caret;
    onChange(next);
  }

  function refreshSuggest(next: string, caret: number, ta: HTMLTextAreaElement) {
    if (readOnly || plain) {
      setSuggest(null);
      return;
    }
    const hit = wordSuggestions(next, caret);
    if (!hit) {
      setSuggest(null);
      return;
    }
    const spot = placeSuggest(ta, caret, hit.prefix.length, hit.items.length);
    if (!spot) {
      setSuggest(null);
      return;
    }
    setSuggest({
      x: spot.x,
      y: spot.y,
      from: hit.from,
      prefix: hit.prefix,
      items: hit.items,
      index: 0,
    });
  }

  function acceptSuggest(item: string) {
    const ta = taRef.current;
    const box = suggestRef.current;
    if (!ta || !box) return;
    const caret = ta.selectionStart ?? box.from + item.length;
    const next = ta.value.slice(0, box.from) + item + ta.value.slice(caret);
    commit(next, box.from + item.length);
    setSuggest(null);
  }

  return (
    <div
      className={"code-editor" + (indentGuides ? " guides" : "") + (wrap ? " wrap" : "") + (rtl ? " rtl" : "")}
      dir={rtl ? "rtl" : "ltr"}
      style={{ ["--fs" as string]: fontSize + "px", ["--lh" as string]: lh + "px" }}
    >
      <div className="gutter" aria-hidden="true">
        <div className="gutter-nums" ref={gutRef}>
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} className="gutter-n">
              {i + 1}
            </div>
          ))}
        </div>
      </div>
      <div className="code-layer">
        {indentGuides && (
          <div className="indent-guides" ref={guideRef} aria-hidden="true">
            {depths.map((depth, i) => (
              <div className="guide-row" key={i}>
                {Array.from({ length: depth }, (_, n) => (
                  <span key={n} className={n + 1 === activeLevel ? "on" : ""} style={{ left: `calc(${(n + 1) * 4}ch)` }} />
                ))}
              </div>
            ))}
          </div>
        )}
        <pre
          className="hl"
          ref={hlRef}
          dangerouslySetInnerHTML={{
            __html: (plain ? escapePlain(value) : highlightPython(value)) || "\n",
          }}
        />
        <textarea
          ref={taRef}
          className="code-input"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          wrap={wrap ? "soft" : "off"}
          readOnly={readOnly}
          value={value}
          aria-label="Cell code"
          onScroll={syncScroll}
          onFocus={(e) => {
            markActive(e.currentTarget);
            onFocus(e.currentTarget);
          }}
          onKeyUp={(e) => markActive(e.currentTarget)}
          onClick={(e) => markActive(e.currentTarget)}
          onSelect={(e) => markActive(e.currentTarget)}
          onBlur={() => {
            window.setTimeout(() => setSuggest(null), 120);
            onBlur();
          }}
          onChange={(e) => {
            const caret = e.target.selectionStart ?? e.target.value.length;
            onChange(e.target.value);
            refreshSuggest(e.target.value, caret, e.target);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu(e.clientX, e.clientY);
          }}
          onTouchStart={(e) => {
            const t = e.touches[0];
            if (!t) return;
            const x = t.clientX;
            const y = t.clientY;
            const timer = window.setTimeout(() => openMenu(x, y), 550);
            const move = (ev: TouchEvent) => {
              const m = ev.touches[0];
              if (!m) return;
              if (Math.abs(m.clientX - x) > 10 || Math.abs(m.clientY - y) > 10) window.clearTimeout(timer);
            };
            const end = () => {
              window.clearTimeout(timer);
              window.removeEventListener("touchmove", move);
              window.removeEventListener("touchend", end);
            };
            window.addEventListener("touchmove", move, { passive: true });
            window.addEventListener("touchend", end);
          }}
          onBeforeInput={(e) => {
            const ne = e.nativeEvent;
            if (!(ne instanceof InputEvent)) return;
            if (ne.inputType !== "insertReplacementText" && ne.inputType !== "insertCompositionText") return;
            const data = ne.data ?? "";
            if (!/[\s\u00a0]$/.test(data)) return;
            const word = data.replace(/[\s\u00a0]+$/g, "");
            if (!word || word === data) return;
            e.preventDefault();
            const ta = e.currentTarget;
            const a = ta.selectionStart ?? 0;
            const b = ta.selectionEnd ?? 0;
            commit(ta.value.slice(0, a) + word + ta.value.slice(b), a + word.length);
          }}
          onKeyDown={(e) => {
            const ta = e.currentTarget;
            const box = suggestRef.current;
            if (box && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              const dir = e.key === "ArrowDown" ? 1 : -1;
              setSuggest({ ...box, index: (box.index + dir + box.items.length) % box.items.length });
              return;
            }
            if (box && (e.key === "Tab" || e.key === "Enter")) {
              e.preventDefault();
              const item = box.items[box.index];
              if (item) acceptSuggest(item);
              return;
            }
            if (box && e.key === "Escape") {
              e.preventDefault();
              setSuggest(null);
              return;
            }
            if (e.key === "Tab") {
              e.preventDefault();
              if (readOnly) return;
              const a = ta.selectionStart ?? 0;
              const b = ta.selectionEnd ?? 0;
              commit(ta.value.slice(0, a) + "    " + ta.value.slice(b), a + 4);
              return;
            }
            if (readOnly) return;
            const a = ta.selectionStart ?? 0;
            const b = ta.selectionEnd ?? 0;
            if (e.key === "Enter") {
              e.preventDefault();
              const stepped = applyEnter(ta.value, a, b);
              commit(stepped.value, stepped.caret);
              setSuggest(null);
              return;
            }
            if (e.key === "Backspace") {
              const paired = applyBackspacePair(ta.value, a, b);
              if (paired) {
                e.preventDefault();
                commit(paired.value, paired.caret);
              }
              return;
            }
            if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
              const paired = applyPair(ta.value, a, b, e.key);
              if (paired) {
                e.preventDefault();
                commit(paired.value, paired.caret);
                refreshSuggest(paired.value, paired.caret, ta);
              }
            }
          }}
        />
      </div>
      {suggest &&
        createPortal(
          <div
            className="suggest"
            style={{ left: suggest.x, top: suggest.y }}
            onPointerDown={(e) => e.preventDefault()}
          >
            {suggest.items.map((item, i) => (
              <button key={item} type="button" className={i === suggest.index ? "on" : ""} onClick={() => acceptSuggest(item)}>
                <span className={"k-" + wordKind(item, value)}>
                  <b>{item.slice(0, suggest.prefix.length)}</b>
                  {item.slice(suggest.prefix.length)}
                </span>
              </button>
            ))}
          </div>,
          document.querySelector(".shell") ?? document.body,
        )}
    </div>
  );
}

function escapePlain(value: string) {
  const html = escapeHtml(value);
  return html.endsWith("\n") ? html : html + "\n";
}

function measureCh(ta: HTMLTextAreaElement) {
  const probe = document.createElement("span");
  probe.textContent = "0000000000";
  const cs = getComputedStyle(ta);
  probe.style.cssText = `position:fixed;left:-9999px;top:0;visibility:hidden;font:${cs.font};white-space:pre`;
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return w || 7.2;
}

function placeSuggest(ta: HTMLTextAreaElement, caret: number, prefixLen: number, itemCount: number) {
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight) || 20;
  const padTop = parseFloat(cs.paddingTop) || 8;
  const padLeft = parseFloat(cs.paddingLeft) || 10;
  const ch = measureCh(ta);
  const upto = ta.value.slice(0, caret).split("\n");
  const col = upto[upto.length - 1]?.length ?? 0;
  const row = upto.length - 1;
  const rect = ta.getBoundingClientRect();
  const wordX = rect.left + padLeft + Math.max(0, col - prefixLen) * ch - ta.scrollLeft;
  const lineTop = rect.top + padTop + row * lh - ta.scrollTop;
  const lineBottom = lineTop + lh;
  if (lineBottom < rect.top + 1 || lineTop > rect.bottom - 1) return null;
  const rows = Math.min(itemCount, 4);
  const popupH = rows * 22 + 4;
  const popupW = 148;
  const vv = window.visualViewport;
  const viewTop = vv?.offsetTop ?? 0;
  const viewBottom = viewTop + (vv?.height ?? window.innerHeight);
  const viewLeft = vv?.offsetLeft ?? 0;
  const viewRight = viewLeft + (vv?.width ?? window.innerWidth);
  const gap = 4;
  const below = lineBottom + gap;
  const above = lineTop - popupH - gap;
  const roomBelow = viewBottom - 8 - below;
  const roomAbove = above - (viewTop + 8);
  let top = below;
  if (popupH > roomBelow && roomAbove > roomBelow) top = Math.max(viewTop + 8, above);
  let left = Math.max(8, wordX);
  if (left + popupW > viewRight - 8) left = Math.max(8, viewRight - popupW - 8);
  return { x: left, y: top };
}
