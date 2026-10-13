// Renders the tree produced by ui.py into the DOM and patches it on every
// update. Nodes look like {t: type, p: props, c: children, k: key}; callback
// props are {$cb: id} and are sent back to Python as (id, JSON args).

export class UIRenderer {
  constructor(root, sendEvent) {
    this.root = root;
    this.sendEvent = sendEvent;
    this.current = null;
    this.onRendered = () => {};
  }

  render(json) {
    const t0 = performance.now();
    const { seq, root, pyMs } = JSON.parse(json);
    if (this.current) {
      const el = this.root.firstChild;
      const replaced = patch(el, this.current, root, this);
      if (replaced !== el) this.root.replaceChild(replaced, el);
    } else {
      this.root.replaceChildren(create(root, this));
    }
    this.current = root;
    this.onRendered(seq, { pyMs, domMs: performance.now() - t0, bytes: json.length });
  }

  clear() {
    this.root.replaceChildren();
    this.current = null;
  }

  emit(el, prop, ...args) {
    const cb = el.__v?.p?.[prop];
    if (cb?.$cb) this.sendEvent(cb.$cb, JSON.stringify(args));
  }
}

const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

// Element in which a node's children live (some components wrap them).
const childHost = (el) => el.__host ?? el;

function create(v, r) {
  const el = BUILDERS[v.t]?.create(v, r) ?? h("div", "ui-unknown", `unknown component ${v.t}`);
  el.__v = v;
  BUILDERS[v.t]?.update?.(el, v.p, {}, r);
  for (const child of v.c ?? []) childHost(el).append(create(child, r));
  return el;
}

/** Patch el (rendered from old) to match next; returns the element to use. */
function patch(el, old, next, r) {
  if (old.t !== next.t || old.k !== next.k) return create(next, r);
  el.__v = next;
  BUILDERS[next.t]?.update?.(el, next.p, old.p, r);
  patchChildren(childHost(el), old.c ?? [], next.c ?? [], r);
  return el;
}

function patchChildren(host, oldKids, newKids, r) {
  const els = Array.from(host.children).filter((e) => e.__v);
  const keyed = newKids.length > 0 && newKids.every((k) => k.k !== undefined);
  if (keyed) {
    const byKey = new Map();
    els.forEach((e, i) => byKey.set(oldKids[i]?.k, { el: e, v: oldKids[i] }));
    let prev = null;
    for (const kid of newKids) {
      const hit = byKey.get(kid.k);
      let el;
      if (hit && hit.v.t === kid.t) {
        el = patch(hit.el, hit.v, kid, r);
        byKey.delete(kid.k);
      } else {
        el = create(kid, r);
      }
      const want = prev ? prev.nextSibling : host.firstChild;
      if (el !== want) host.insertBefore(el, want);
      prev = el;
    }
    for (const { el } of byKey.values()) el.remove();
    return;
  }
  for (let i = 0; i < newKids.length; i++) {
    if (i < els.length) {
      const el = patch(els[i], oldKids[i], newKids[i], r);
      if (el !== els[i]) host.replaceChild(el, els[i]);
    } else {
      host.append(create(newKids[i], r));
    }
  }
  for (let i = newKids.length; i < els.length; i++) els[i].remove();
}

const setText = (el, text) => {
  if (el.textContent !== (text ?? "")) el.textContent = text ?? "";
};
const toggleClass = (el, cls, on) => el.classList.toggle(cls, !!on);

const BUILDERS = {
  Screen: {
    create() {
      const el = h("div", "ui-screen");
      el.__title = h("h1", "ui-screen-title");
      el.__host = h("div", "ui-screen-content");
      el.append(el.__title, el.__host);
      return el;
    },
    update(el, p) {
      setText(el.__title, p.title);
      el.__title.hidden = !p.title;
    },
  },
  Section: {
    create() {
      const el = h("section", "ui-section");
      el.__header = h("div", "ui-section-header");
      el.__host = h("div", "ui-section-body");
      el.__footer = h("div", "ui-section-footer");
      el.append(el.__header, el.__host, el.__footer);
      return el;
    },
    update(el, p) {
      setText(el.__header, p.header);
      el.__header.hidden = !p.header;
      setText(el.__footer, p.footer);
      el.__footer.hidden = !p.footer;
    },
  },
  VStack: { create: () => h("div", "ui-vstack"), update: stackUpdate },
  HStack: { create: () => h("div", "ui-hstack"), update: stackUpdate },
  Spacer: { create: () => h("div", "ui-spacer") },
  Text: {
    create: () => h("div", "ui-text"),
    update(el, p, old) {
      setText(el, p.text);
      if (p.style !== old.style) {
        if (old.style) el.classList.remove(`ui-text-${old.style}`);
        el.classList.add(`ui-text-${p.style}`);
      }
      el.style.color = p.color ?? "";
    },
  },
  Button: {
    create(v, r) {
      const el = h("button", "ui-button");
      el.addEventListener("click", () => r.emit(el, "on_tap"));
      return el;
    },
    update(el, p, old) {
      setText(el, p.label);
      if (p.style !== old.style) {
        if (old.style) el.classList.remove(`ui-button-${old.style}`);
        el.classList.add(`ui-button-${p.style}`);
      }
      el.disabled = !!p.disabled;
    },
  },
  TextField: {
    create(v, r) {
      const el = h("input", "ui-textfield");
      el.autocapitalize = "sentences";
      el.addEventListener("input", () => r.emit(el, "on_change", el.value));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") r.emit(el, "on_submit", el.value);
      });
      return el;
    },
    update(el, p) {
      el.placeholder = p.placeholder ?? "";
      // Only overwrite when Python's value differs from what is in the field,
      // so the caret is not reset while typing.
      const value = p.value ?? "";
      if (el.value !== value) el.value = value;
    },
  },
  Toggle: {
    create(v, r) {
      const el = h("label", "ui-toggle");
      el.__label = h("span", "ui-toggle-label");
      el.__input = h("input", "ui-switch");
      el.__input.type = "checkbox";
      el.__input.addEventListener("change", () => r.emit(el, "on_change", el.__input.checked));
      el.append(el.__label, el.__input);
      return el;
    },
    update(el, p) {
      setText(el.__label, p.label);
      el.__input.checked = !!p.value;
    },
  },
  Slider: {
    create(v, r) {
      const el = h("input", "ui-slider");
      el.type = "range";
      el.addEventListener("input", () => r.emit(el, "on_change", Number(el.value)));
      return el;
    },
    update(el, p) {
      el.min = p.min ?? 0;
      el.max = p.max ?? 1;
      el.step = p.step ?? "any";
      if (Number(el.value) !== p.value) el.value = p.value;
    },
  },
  Row: {
    create(v, r) {
      const el = h("div", "ui-row");
      el.__check = h("span", "ui-row-check");
      el.__text = h("div", "ui-row-text");
      el.__title = h("div", "ui-row-title");
      el.__subtitle = h("div", "ui-row-subtitle");
      el.__detail = h("div", "ui-row-detail");
      el.__delete = h("button", "ui-row-delete", "Delete");
      el.__text.append(el.__title, el.__subtitle);
      el.append(el.__check, el.__text, el.__detail, el.__delete);
      el.addEventListener("click", (e) => {
        if (e.target === el.__delete) r.emit(el, "on_delete");
        else r.emit(el, "on_tap");
      });
      return el;
    },
    update(el, p) {
      setText(el.__title, p.title);
      setText(el.__subtitle, p.subtitle);
      el.__subtitle.hidden = !p.subtitle;
      setText(el.__detail, p.detail);
      el.__detail.hidden = p.detail == null;
      el.__check.hidden = p.checked == null;
      toggleClass(el.__check, "checked", p.checked);
      toggleClass(el, "ui-row-done", p.checked);
      toggleClass(el, "ui-row-tappable", !!p.on_tap);
      el.__delete.hidden = !p.on_delete;
    },
  },
  Image: {
    create: () => h("img", "ui-image"),
    update(el, p) {
      if (el.getAttribute("src") !== p.src) el.src = p.src;
      el.style.width = p.width ? `${p.width}px` : "";
      el.style.height = p.height ? `${p.height}px` : "";
    },
  },
};

function stackUpdate(el, p) {
  el.style.gap = `${p.spacing ?? 8}px`;
  el.style.alignItems = { leading: "flex-start", trailing: "flex-end", center: "center" }[p.align] ?? p.align ?? "";
  el.style.padding = p.padding != null ? `${p.padding}px` : "";
}
