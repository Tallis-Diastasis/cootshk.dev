extension({
    id: "bottomExpressions",
    ready(Calc) {
        Calc.controller.isNarrow = () => true;
    }
});
