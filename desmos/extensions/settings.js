extension({
    id: "settings",
    patches: [
        {
            match: /(class:"dcg-my-graphs-modal__tab",children:)(\i)\((.*?),children:\(\)=>(this\.controller\.\i)(\("account-shell-heading-mygraphs-examples"\)}\)}\)}\))/,
            replace: "\n$1$2($3,children:()=>$4$5,"+`$2("div", {
                class: "dcg-my-graphs-modal__tab",
                children: [
                    $2("a", {
                        class : () => ({
                            'dcg-unstyled-heading': !0,
                            'dcg-my-graphs-modal__heading': !0,
                            'dcg-my-graphs-modal__heading--selectable': !0,
                            'dcg-my-graphs-modal-cde-extensions-header': !0,
                            'dcg-selected': this.myGraphsController.getCurrentTab() === 'cde-extensions'
                        }),
                        role: 'tab',
                        tabIndex: () => this.myGraphsController.getCurrentTab() === 'cde-extensions' ? 0 : 1,
                        'aria-selected': () => this.myGraphsController.getCurrentTab() === 'cde-extensions',
                        onKeyDown: this.bindFn(this.handleTablistKeyDown),
                        onTap: () => this.updateCurrentTab("cde-extensions"),
                        children: $4("cde-extensions-heading")
                    })
                ]
            })
            `
        },
        {
            match: /mq-narration-token = token(\n*)/,
            replace: `
mq-narration-token = token
cde-extensions-heading = Extensions
            `.trim()
        }
    ],
    ready() {
        console.log("settings extension loaded");

    }
})