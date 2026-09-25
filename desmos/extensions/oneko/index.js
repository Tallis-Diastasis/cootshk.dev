extension({
    id: "oneko",
    ready() {
        fetch("https://raw.githubusercontent.com/adryd325/oneko.js/c4ee66353b11a44e4a5b7e914a81f8d33111555e/oneko.js")
            .then(x => x.text())
            .then(s => s.replace("./oneko.gif", "/cdn/media/oneko.gif")
                .replace("(isReducedMotion)", "(false)"))
            .then(eval);
    },
    // todo: will be added later
    stop() {
        document.querySelector("#oneko")?.remove();
    }
})