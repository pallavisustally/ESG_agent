function roundCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num);
}

function formatCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function formatPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return `${Number(num.toFixed(2))}%`;
}

function buildShareEntry({ percent, numerator, denominator, numeratorLabel, denominatorLabel }) {
  const pct = Number(percent);
  const num = roundCount(numerator);
  const den = roundCount(denominator);
  if (!Number.isFinite(pct) || pct < 0) return null;

  const entry = {
    percent: Number(pct.toFixed(2)),
    display_percent: formatPercent(pct),
  };

  if (num != null && den != null && den > 0) {
    entry.numerator = num;
    entry.denominator = den;
    entry.numerator_label = numeratorLabel;
    entry.denominator_label = denominatorLabel;
    entry.display = `${formatPercent(pct)} (${formatCount(num)} ${numeratorLabel} of ${formatCount(den)} ${denominatorLabel})`;
  } else if (num != null) {
    entry.numerator = num;
    entry.numerator_label = numeratorLabel;
    entry.display = `${formatPercent(pct)} (${formatCount(num)} ${numeratorLabel}; total denominator not indexed)`;
  } else {
    entry.display = formatPercent(pct);
    entry.note = 'Only the percentage is available in the database for this metric.';
  }

  return entry;
}

export function deriveTotalEmployeeCount(row) {
  const stored = Number(row.total_employee_count);
  if (Number.isFinite(stored) && stored > 0) return stored;

  const female = Number(row.female_employee_count);
  const share = Number(row.female_employee_share);
  if (Number.isFinite(female) && female > 0 && Number.isFinite(share) && share > 0) {
    return Math.round(female / (share / 100));
  }
  return null;
}

export function buildShareBreakdown(row) {
  if (!row || typeof row !== 'object') return {};

  const breakdown = {};

  const totalEmployees = deriveTotalEmployeeCount(row);
  const femaleEmployees = Number(row.female_employee_count);
  const femaleShare = Number(row.female_employee_share);
  if (row.female_employee_share != null && Number.isFinite(femaleShare)) {
    const entry = buildShareEntry({
      percent: femaleShare,
      numerator: Number.isFinite(femaleEmployees) && femaleEmployees > 0 ? femaleEmployees : null,
      denominator: totalEmployees,
      numeratorLabel: 'female permanent employees',
      denominatorLabel: 'total permanent employees',
    });
    if (entry) breakdown.female_employee_share = entry;
  }

  const femaleBoard = Number(row.female_board_count);
  const totalBoard = Number(row.total_board_count);
  const femaleBoardShare = Number(row.female_board_share);
  if (row.female_board_share != null && Number.isFinite(femaleBoardShare)) {
    const entry = buildShareEntry({
      percent: femaleBoardShare,
      numerator: Number.isFinite(femaleBoard) && femaleBoard > 0 ? femaleBoard : null,
      denominator: Number.isFinite(totalBoard) && totalBoard > 0 ? totalBoard : null,
      numeratorLabel: 'female board directors',
      denominatorLabel: 'total board directors',
    });
    if (entry) breakdown.female_board_share = entry;
  }

  const renewable = Number(row.renewable_energy_consumption);
  const totalEnergy = Number(row.energy_consumption);
  const renewableShare = Number(row.renewable_energy_share);
  if (row.renewable_energy_share != null && Number.isFinite(renewableShare)) {
    const entry = buildShareEntry({
      percent: renewableShare,
      numerator: Number.isFinite(renewable) && renewable > 0 ? renewable : null,
      denominator: Number.isFinite(totalEnergy) && totalEnergy > 0 ? totalEnergy : null,
      numeratorLabel: 'GJ renewable',
      denominatorLabel: 'GJ total',
    });
    if (entry) breakdown.renewable_energy_share = entry;
  }

  const wasteRecycled = Number(row.waste_recovered_recycled);
  const wasteGenerated = Number(row.waste_generated);
  if (Number.isFinite(wasteGenerated) && wasteGenerated > 0 && Number.isFinite(wasteRecycled) && wasteRecycled >= 0) {
    const recyclingRate = Math.round((wasteRecycled / wasteGenerated) * 10000) / 100;
    const entry = buildShareEntry({
      percent: recyclingRate,
      numerator: wasteRecycled,
      denominator: wasteGenerated,
      numeratorLabel: 'tonnes recycled',
      denominatorLabel: 'tonnes waste generated',
    });
    if (entry) breakdown.waste_recycling_rate = entry;
  }

  return breakdown;
}
