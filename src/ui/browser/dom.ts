/**
 * The four DOM chores every element module repeats: a constructed
 * stylesheet (the CSP allows no inline styles, so styles are objects), a
 * template, an idempotent `define`, and the shell's vocabulary CSS adopted
 * once so a shadow tree can use `.btn`, `.mark`, and the tokens.
 */

export function sheet(css: string): CSSStyleSheet {
  const styles = new CSSStyleSheet();
  styles.replaceSync(css);
  return styles;
}

export function template(html: string): HTMLTemplateElement {
  const element = document.createElement("template");
  element.innerHTML = html;
  return element;
}

/** Define a tag once; a second theme entry on the same page (or a re-import) must not throw. */
export function define(tag: string, cls: CustomElementConstructor): void {
  if (customElements.get(tag)) return;
  customElements.define(tag, cls);
}

let vocabulary: CSSStyleSheet | undefined;

/** The page's `<style id="ht-css">` as one shared sheet, built on first use. */
export function vocabularySheet(): CSSStyleSheet {
  vocabulary ??= sheet(document.getElementById("ht-css")?.textContent ?? "");
  return vocabulary;
}
