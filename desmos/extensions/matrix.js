extension({
  id: "matrix",

  patches: [
    {
      match: /\i\.includes\(\i\)\|\|(?=\i\.restrictedFunctions)/g,
      replace: "",
      count: 1,
    },
  ],

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
