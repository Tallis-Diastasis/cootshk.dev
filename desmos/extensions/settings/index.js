extension({
    id: "settings",
    patches: [
        // The heading, appended to the tablist after the "Examples" tab.
        {
            match: /(class:"dcg-my-graphs-modal__tab",children:)(\i)\((.*?),children:\(\)=>(this\.controller\.\i)(\("account-shell-heading-mygraphs-examples"\)}\)}\)}\))/,
            count: 1,
            replace:
                "\n$1$2($3,children:()=>$4$5," +
                `$2("div", {
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
                        tabIndex: () => this.myGraphsController.getCurrentTab() === 'cde-extensions' ? 0 : -1,
                        'aria-selected': () => this.myGraphsController.getCurrentTab() === 'cde-extensions',
                        onKeyDown: this.bindFn(this.handleTablistKeyDown),
                        onTap: () => this.updateCurrentTab("cde-extensions"),
                        children: $4("cde-extensions-heading")
                    })
                ]
            })
            `
        },
        // "Extensions" translation text
        // TODO: move this to an api in the core plugin
        {
            match: /mq-narration-token = token(\n*)/,
            count: 1,
            replace:
                `
mq-narration-token = token
cde-extensions-heading = Extensions
            `.trim() + "$1"
        },
        // The body. The modal picks between the example gallery and the graph tiles; wrap
        // that choice in one of our own so the tab gets the whole content area to itself.
        {
            match: /(\i)\(\(\)=>this\.myGraphsController\.getCurrentTab\(\)==="example-graphs"(&&[^,]*,\{true:\(\)=>(\i)\(\i,\{controller:this\.props\.controller}\),false:\(\)=>\i\(\i,\{controller:this\.props\.controller}\)})\)/,
            count: 1,
            replace:
                '$1(()=>this.myGraphsController.getCurrentTab()==="cde-extensions",{' +
                'true:()=>$3("div",{class:"cde-ext-tab",' +
                'didMount:(e)=>window.__desmosExt.ui.mount("extensions",e),' +
                "willUnmount:(e)=>window.__desmosExt.ui.unmount(e)})," +
                'false:()=>$1(()=>this.myGraphsController.getCurrentTab()==="example-graphs"$2)})'
        }
    ],

    main() {
        var ui = window.__desmosExt.ui;

        ui.slot("extensions", function (root) {
            var search = ui.el("input", {
                class: "cde-ext__search",
                type: "search",
                placeholder: "Search extensions",
                "aria-label": "Search extensions",
                oninput: filter
            });

            var reload = ui.el("button", {
                class: "cde-ext__reload",
                type: "button",
                text: "Apply and Reload",
                hidden: !ui.dirty(),
                onclick: ui.reload
            });

            var grid = ui.el("div", { class: "cde-ext__grid" });
            var empty = ui.el("p", { class: "cde-ext__empty", hidden: true });

            var cards = ui.list().map(function (entry) {
                return {
                    node: card(entry),
                    // id included: it is what ?ext= takes, so it is worth being able to
                    // search for even though the card shows the name.
                    haystack: (
                        entry.name +
                        " " +
                        entry.description +
                        " " +
                        entry.id
                    ).toLowerCase()
                };
            });
            grid.append.apply(
                grid,
                cards.map(function (one) {
                    return one.node;
                })
            );

            ui.el(
                root,
                null,
                ui.el("div", { class: "cde-ext__bar" }, search, reload),
                ui.overridden()
                    ? ui.el("p", {
                          class: "cde-ext__note",
                          text: "?ext= in the URL is overriding these."
                      })
                    : null,
                grid,
                empty
            );

            function filter() {
                var query = search.value.trim();
                var needle = query.toLowerCase();
                var shown = 0;
                cards.forEach(function (one) {
                    var hit = !needle || one.haystack.indexOf(needle) !== -1;
                    one.node.hidden = !hit;
                    if (hit) shown++;
                });
                empty.hidden = shown > 0;
                empty.textContent = 'No extensions match "' + query + '".';
            }

            return ui.onDirty(function () {
                reload.hidden = !ui.dirty();
            });
        });

        function card(entry) {
            var box = ui.el("input", {
                class: "cde-ext-toggle__box",
                type: "checkbox",
                checked: ui.enabled(entry.id),
                disabled: ui.locked(entry.id),
                "aria-label": entry.name,
                onchange: function () {
                    ui.setEnabled(entry.id, box.checked);
                }
            });

            var toggle = ui.el(
                "label",
                {
                    class: "cde-ext-toggle",
                    title: entry.forced
                        ? "Always on"
                        : ui.overridden()
                          ? "?ext= in the URL is overriding this"
                          : null
                },
                box,
                ui.el("span", { class: "cde-ext-toggle__track" })
            );

            return ui.el(
                "div",
                {
                    class:
                        "cde-ext-card" +
                        (entry.supported ? "" : " cde-ext-card--unsupported")
                },
                ui.el(
                    "div",
                    { class: "cde-ext-card__head" },
                    ui.el("h3", {
                        class: "cde-ext-card__name",
                        text: entry.name
                    }),
                    toggle
                ),
                ui.el("p", {
                    class: "cde-ext-card__desc",
                    text: entry.supported
                        ? entry.description
                        : "Not available on this calculator."
                }),
                // A panel belongs to a running extension, so there is nothing to draw for one
                // that has been switched off until the page is reloaded.
                ui.hasPanel(entry.id) ? settings(entry) : null
            );
        }

        /** The "Settings" disclosure on a card, drawn the first time it is opened. */
        function settings(entry) {
            var panel = ui.el("div", {
                class: "cde-ext-card__panel",
                hidden: true
            });
            var drawn = false;
            var button = ui.el("button", {
                class: "cde-ext-card__more",
                type: "button",
                text: "Settings",
                "aria-expanded": "false",
                onclick: function () {
                    panel.hidden = !panel.hidden;
                    button.setAttribute("aria-expanded", String(!panel.hidden));
                    if (drawn) return;
                    drawn = true;
                    ui.renderPanel(entry.id, panel);
                }
            });
            return [button, panel];
        }
    }
});
