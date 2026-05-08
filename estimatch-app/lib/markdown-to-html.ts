/**
 * Minimal markdown-to-HTML converter for controlled AI output.
 * Handles: headers, tables, bold, italic, code, lists, horizontal rules, paragraphs.
 * HTML entities are escaped BEFORE markdown processing to prevent XSS.
 */

function inlineMd(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

export function markdownToHtml(md: string): string {
  // Escape HTML entities first to neutralize any injected markup
  const escaped = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const lines = escaped.split('\n');
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // Empty line
    if (!trimmed) { i++; continue; }

    // Headers (## only, per our prompt rules)
    if (trimmed.startsWith('## ')) {
      output.push(`<h2>${inlineMd(trimmed.slice(3))}</h2>`);
      i++; continue;
    }
    if (trimmed.startsWith('### ')) {
      output.push(`<h3>${inlineMd(trimmed.slice(4))}</h3>`);
      i++; continue;
    }
    if (trimmed.startsWith('# ')) {
      output.push(`<h1>${inlineMd(trimmed.slice(2))}</h1>`);
      i++; continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed)) {
      output.push('<hr/>');
      i++; continue;
    }

    // Table: current line has |, next line is separator row
    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      /^\|?[\s\-:|]+\|?$/.test(lines[i + 1].trim())
    ) {
      // Split on pipes; preserve interior empty cells. Strip only the leading/trailing
      // empty strings produced by surrounding pipes (e.g. "| A | B |" → ["A", "B"]).
      const splitRow = (row: string): string[] => {
        const parts = row.split('|').map(c => c.trim());
        if (parts.length > 0 && parts[0] === '') parts.shift();
        if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
        return parts;
      };
      const headerCells = splitRow(trimmed);
      let table = '<table><thead><tr>';
      table += headerCells.map(c => `<th>${inlineMd(c)}</th>`).join('');
      table += '</tr></thead><tbody>';
      i += 2; // skip header + separator
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim() !== '') {
        const cells = splitRow(lines[i].trim());
        table += '<tr>' + cells.map(c => `<td>${inlineMd(c)}</td>`).join('') + '</tr>';
        i++;
      }
      table += '</tbody></table>';
      output.push(table);
      continue;
    }

    // Unordered list
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      let list = '<ul>';
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t.startsWith('- ')) { list += `<li>${inlineMd(t.slice(2))}</li>`; i++; }
        else if (t.startsWith('* ')) { list += `<li>${inlineMd(t.slice(2))}</li>`; i++; }
        else break;
      }
      list += '</ul>';
      output.push(list);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(trimmed)) {
      let list = '<ol>';
      while (i < lines.length) {
        const m = lines[i].trim().match(/^\d+\.\s(.+)$/);
        if (!m) break;
        list += `<li>${inlineMd(m[1])}</li>`;
        i++;
      }
      list += '</ol>';
      output.push(list);
      continue;
    }

    // Regular paragraph
    output.push(`<p>${inlineMd(trimmed)}</p>`);
    i++;
  }

  return output.join('\n');
}
