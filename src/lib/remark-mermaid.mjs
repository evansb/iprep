/**
 * Turn ```mermaid fences into `<pre class="mermaid">` blocks.
 *
 * This runs at the remark stage, before Shiki sees the tree, so mermaid code is
 * never syntax-highlighted as a code block — it is handed to the client-side
 * renderer in `src/components/MermaidRenderer.astro` instead.
 *
 * The original diagram source is preserved, URI-encoded, in `data-mermaid`.
 * Keeping a pristine copy lets the renderer rebuild each diagram from scratch
 * when the colour theme changes, rather than trying to re-theme emitted SVG.
 */

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Walk the mdast, replacing mermaid code nodes in place. */
function transform(node) {
  const children = node.children;
  if (!Array.isArray(children)) return;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'code' && child.lang === 'mermaid') {
      // encodeURIComponent escapes `"` and `&`, so the attribute is safe as-is.
      children[i] = {
        type: 'html',
        value:
          `<pre class="mermaid" data-mermaid="${encodeURIComponent(child.value)}">` +
          `${escapeHtml(child.value)}</pre>`,
      };
    } else {
      transform(child);
    }
  }
}

export function remarkMermaid() {
  return (tree) => transform(tree);
}
