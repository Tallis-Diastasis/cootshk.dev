extension({
    id: "limitlessLists",
    patches: [
        // error message
        {
            match: /(shared-calculator-error-max-list-size = )[a-zA-Z._${} \-]+\n?/,
            replace:
                "$1Stop it. Get some help. Lists shouldn't have more than { $maxListSize } elements.\n",
            count: 1
        },
        // Error message
        {
            match: /maxListSize:1e4(?=\.toLocaleString\(\))/,
            replace: "maxListSize:1e8",
            count: 1
        },
        // the actual checks
        {
            match: />1e4(?=\)throw \i\(\))/,
            replace: ">1e8"
        },
        {
            match: /\$\{1e4}(?=\) throw ErrorMsg\.maxListSize\(\);)/,
            replace: "${1e8}",
            count: 1
        }
    ]
});
