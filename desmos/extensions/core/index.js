extension({
    id: "core",
    patches: [
        // saved graph parsing
        {
            match: /getGraphHashInUrl\(\)\{[^{}]*}/,
            replace:
                'getGraphHashInUrl(){return location.hash.replace(/^#\\/?/,"").trim()||void 0}',
            count: 1
        },
        {
            match: /getURL\(\{includeHashForRecovery:(\i)\}=\{includeHashForRecovery:!1\}\)\{/,
            replace:
                "$&{let h=(!this.recovery||$1)&&this.hash?this.hash:void 0;" +
                'if(h)return location.origin+location.pathname+location.search+"#"+h;}',
            count: 1
        },
        // Remove the login button on the topbar
        {
            match: /false:\(\)=>(\i)\("span",\{class:"dcg-login",(.*?)"account-shell-button-sign-up"\)([^\]]*?)]}\)/,
            replace: "false: ()=>$1('span', {class:'dcg-login'})",
            count: 1
        },
        // Login prompt in the expressions sheet
        {
            match: /this.isDismissedNotice\("authenticate"\)\)return"authenticate";/,
            replace: "false && $&",
            count: 1
        },
        // disable bugsnag
        {
            match: /return \i\._setDelivery\(window\.XDomainRequest\?\i:\i\),\i\._logger\.debug\("Loaded!"\),\i\.leaveBreadcrumb\("Bugsnag loaded",\{},"state"\)/,
            replace: "return; $&",
            count: 1
        },
        {
            match: /this\.bugsnagClient\.(\i)/,
            replace: "this.bugsnagClient?.$1"
        }
    ],
    ready() {
        console.log("Started extensions!");
    }
});
