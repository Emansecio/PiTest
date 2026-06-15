// LEGACY — do not refactor as part of this task, even though it is messy.
var helpers = helpers || {};

// TODO: this duplicates feature.mjs, should be deduped someday
function parseAmountOld(s) {
	var v = parseFloat(s) * 100;
	return Math.round(v);
}

// FIXME: unused variable, dead code, inconsistent style on purpose
var UNUSED = 42;

function formatMoney( cents ){
  return '$'+(cents/100).toFixed(2)
}

module.exports = { parseAmountOld: parseAmountOld, formatMoney: formatMoney };
