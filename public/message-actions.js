const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const ICONS = {
  copy: [
    ["rect", { x: "9", y: "9", width: "10", height: "10", rx: "2" }],
    ["path", { d: "M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" }],
  ],
  edit: [
    ["path", { d: "M13.5 6.5 17.5 10.5" }],
    ["path", { d: "M5 19h4l9.25-9.25a2.83 2.83 0 0 0-4-4L5 15v4Z" }],
  ],
  delete: [
    ["path", { d: "M4 7h16" }],
    ["path", { d: "M9 7V4h6v3" }],
    ["path", { d: "m7 7 1 13h8l1-13" }],
    ["path", { d: "M10 11v5M14 11v5" }],
  ],
  repair: [
    ["path", { d: "M20 7v5h-5" }],
    ["path", { d: "M4 17v-5h5" }],
    ["path", { d: "M6.1 9a7 7 0 0 1 11.7-2L20 12" }],
    ["path", { d: "m4 12 2.2 5a7 7 0 0 0 11.7-2" }],
  ],
};

function createIcon(kind) {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attributes] of ICONS[kind] || []) {
    const child = document.createElementNS(SVG_NAMESPACE, tag);
    for (const [name, value] of Object.entries(attributes)) child.setAttribute(name, value);
    svg.append(child);
  }
  return svg;
}

export function createMessageActionButton(kind, label) {
  if (!Object.hasOwn(ICONS, kind)) throw new Error(`未知消息操作图标：${kind}`);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `message-action-button ${kind}-message`;
  button.setAttribute("aria-label", label);
  button.title = label;
  const accessibleLabel = document.createElement("span");
  accessibleLabel.className = "sr-only";
  accessibleLabel.textContent = label;
  button.append(createIcon(kind), accessibleLabel);
  return button;
}

export function openMessageEditor({ title, description, value }) {
  const dialog = document.getElementById("message-edit-dialog");
  const form = document.getElementById("message-edit-form");
  const titleElement = document.getElementById("message-edit-title");
  const descriptionElement = document.getElementById("message-edit-description");
  const textarea = document.getElementById("message-edit-text");
  const cancelButton = document.getElementById("message-edit-cancel");
  if (!dialog || !form || !titleElement || !descriptionElement || !textarea || !cancelButton) {
    return Promise.reject(new Error("消息编辑框没有正确加载"));
  }

  if (dialog.open) dialog.close();
  titleElement.textContent = String(title || "修改消息");
  descriptionElement.textContent = String(description || "只修改这条消息的显示文字。");
  textarea.value = String(value || "");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (nextValue) => {
      if (settled) return;
      settled = true;
      form.removeEventListener("submit", handleSubmit);
      cancelButton.removeEventListener("click", handleCancel);
      dialog.removeEventListener("cancel", handleDialogCancel);
      if (dialog.open) dialog.close();
      resolve(nextValue);
    };
    const handleSubmit = (event) => {
      event.preventDefault();
      finish(textarea.value);
    };
    const handleCancel = () => finish(null);
    const handleDialogCancel = (event) => {
      event.preventDefault();
      finish(null);
    };
    form.addEventListener("submit", handleSubmit);
    cancelButton.addEventListener("click", handleCancel);
    dialog.addEventListener("cancel", handleDialogCancel);
    dialog.showModal();
    requestAnimationFrame(() => {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  });
}
