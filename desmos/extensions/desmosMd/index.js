const loadHighlightJS = (callback) => {
    const script = document.createElement("script");
    script.src =
        "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js";
    script.onload = callback;
    document.head.appendChild(script);
};

const parseMarkdown = (md) => {
    md = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const codeBlocks = [];

    md = md.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
        const id = codeBlocks.length;
        codeBlocks.push({
            lang,
            code: code.trim()
        });
        return `%%CODEBLOCK_${id}%%`;
    });

    md = md
        .replace(/^### (.*)$/gim, "<h3>$1</h3>")
        .replace(/^## (.*)$/gim, "<h2>$1</h2>")
        .replace(/^# (.*)$/gim, "<h1>$1</h1>");

    md = md.replace(/(?:^|\n)(- .+(?:\n- .+)*)/g, (match) => {
        const items = match
            .trim()
            .split("\n")
            .map((line) => `<li>${line.replace(/^- /, "")}</li>`)
            .join("");
        return `<ul>${items}</ul>`;
    });

    md = md
        .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
        .replace(/\*(.*?)\*/g, "<i>$1</i>")
        .replace(/`(.*?)`/g, "<code>$1</code>");

    md = md.replace(
        /\[(.*?)]\((.*?)\)/g,
        `<a href="$2" target="_blank">$1</a>`
    );

    // dont break existing graphs with links
    md = md.replace(
        /(^|[^"'>])(https?:\/\/[^\s<]+)/g,
        '$1<a href="$2" target="_blank">$2</a>'
    );

    md = md.replace(
        /(^|[^"'>])\b(www\.[^\s<]+)/g,
        '$1<a href="http://$2" target="_blank">$2</a>'
    );

    md = md.replace(/\n{2,}/g, "<br>");

    md = md.replace(/%%CODEBLOCK_(\d+)%%/g, (_, i) => {
        const { lang, code } = codeBlocks[i];
        const cls = lang ? ` class="language-${lang}"` : "";
        return `<pre><code${cls}>${code}</code></pre>`;
    });

    return md;
};

const highlightCode = (container) => {
    if (!window.hljs) return;

    const blocks = container.querySelectorAll("pre code");

    blocks.forEach((block) => {
        if (block.dataset.highlighted) return;

        window.hljs.highlightElement(block);
        block.dataset.highlighted = "true";
    });
};
const renderMarkdownNotes = () => {
    const state = Calc.getState();
    const expressions = state?.expressions?.list;
    if (!expressions) return;

    const noteMap = new Map();
    for (const e of expressions) {
        if (e.type === "text") {
            noteMap.set(String(e.id), e);
        }
    }

    const nodes = document.querySelectorAll(
        ".dcg-expressionitem.dcg-expressiontext"
    );

    nodes.forEach((node) => {
        const id = node.getAttribute("expr-id");
        const note = noteMap.get(id);
        if (!note) return;

        const display = node.querySelector(".dcg-displayTextarea");
        if (!display) return;

        const raw = note.text || "";

        if (display.dataset.mdRendered === raw) return;

        display.innerHTML = parseMarkdown(raw);
        display.dataset.mdRendered = raw;

        highlightCode(display);
    });
};

extension({
    id: "desmosMd",
    ready(Calc) {
        loadHighlightJS(() => {
            renderMarkdownNotes();

            Calc.observeEvent("change", () => {
                renderMarkdownNotes();
            });
        });
    }
});
