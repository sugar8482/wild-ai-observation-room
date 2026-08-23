export function boldTextParts(value) {
  const source = String(value ?? "");
  const parts = [];
  const pattern = /\*\*([^*]+(?:\*(?!\*)[^*]*)*)\*\*/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) parts.push({ strong: false, text: source.slice(cursor, match.index) });
    parts.push({ strong: true, text: match[1] });
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) parts.push({ strong: false, text: source.slice(cursor) });
  if (!parts.length) parts.push({ strong: false, text: source });
  return parts;
}

export function appendBoldText(element, value) {
  for (const part of boldTextParts(value)) {
    if (!part.strong) {
      element.append(document.createTextNode(part.text));
      continue;
    }
    const strong = document.createElement("strong");
    strong.textContent = part.text;
    element.append(strong);
  }
  return element;
}
