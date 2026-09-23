// Name, description, which calculators it is for and whether it is on by default are all
// declared in extensions.json.
extension({
  id: "matrix",

  source(js) {
    const check = /[\w$]+\.includes\([\w$]+\)\|\|(?=[\w$]+\.restrictedFunctions)/g;
    const found = (js.match(check) || []).length;
    if (found !== 1) throw new Error(`expected 1 restrictedFunctions check, found ${found}`);
    return js.replace(check, "");
  },

  ready(Calc) {
    Calc._calc.graphSettings.config.matrices = true;
    const original = Calc.controller.getMathquillConfig;
    Calc.controller.getMathquillConfig = (e) => {
      const config = original.call(Calc.controller, e);
      config.autoOperatorNames +=
        " rowMatrix zeroMatrix hcat vcat rows columns det trace rref matrixElement rowCount colCount submatrix";
      return config;
    };
  },
});
