extension({
    id: "core",
    patches: [
        {
            match: /console.log\([^()]*iFrame[^()]*\)/i,
            replace: "((()=>{})())",
            count: 1
        }
    ],
    ready() {
        console.log("Started extensions!")
    }
})
