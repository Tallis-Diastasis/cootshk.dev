// The core set of patches required to load Desmos
//
// Desmos keeps the graph ID in location.pathname - /calculator/abcdef1234 - and this page is
// at /desmos, which is not a URL it can navigate to or be reloaded on. location cannot be
// faked (window.location is not configurable) and history.replaceState would put the lie in
// the address bar, so the ID lives in the #fragment instead and these two patches teach
// Desmos to read and write it there. desmos.js currentGraph() is the other half.
extension({
    id: "core",
    patches: [
        // Reading. Upstream:
        //   getGraphHashInUrl(){let e=xa(this.getProduct());
        //     if(window.location.pathname.startsWith(e))
        //       return window.location.pathname.split("/").filter(Boolean)[1]}
        // The body has no braces of its own, so the whole method can be replaced outright.
        {
            match: /getGraphHashInUrl\(\)\{[^{}]*\}/,
            replace:
                'getGraphHashInUrl(){return location.hash.replace(/^#\\/?/,"").trim()||void 0}',
            count: 1
        },
        // Writing: getURL() is what the save/open flow hands to history.pushState. This one's
        // body does have braces, so rather than match it, shadow it - an early return at the
        // top leaves the original as an unreachable tail. Which is also the fallback: with no
        // graph to name, that tail already returns https://<origin>/desmos.
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
        }
    ],
    ready() {
        console.log("Started extensions!");
    }
});
