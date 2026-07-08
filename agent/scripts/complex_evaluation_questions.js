/**
 * 15 complicated BRSR/ESG agent questions tailored to this project's SQLite schema.
 * Tests: self-joins, sector benchmarks, intensity metrics, scope math, charts, composite scoring.
 */

export const COMPLEX_EVALUATION_QUESTIONS = [
  {
    id: 1,
    difficulty: 'complex',
    category: 'Scope Emissions',
    name: 'Scope 1+2+3 Mix — Top Emitter',
    question:
      'Find the company with the highest combined Scope 1 + Scope 2 + Scope 3 emissions in 2025. Show the three scope values, total, and a pie chart of the scope mix.',
    requiresChart: true,
    rubric:
      'Must query scope1_emissions, scope2_emissions, scope3_emissions for 2025, identify the top company by sum, show numeric breakdown, and include a pie/doughnut json-chart with three slices.',
  },
  {
    id: 2,
    difficulty: 'complex',
    category: 'Renewable Energy',
    name: 'Green Energy Leaders Below Sector Carbon Avg',
    question:
      'In the Energy sector for 2025, list companies with renewable_energy_share above 30% AND emissions_intensity below the Energy sector average. Show company, renewable share, emissions intensity, and sector average.',
    requiresChart: true,
    rubric:
      'Requires sector filter, HAVING/subquery for sector AVG(emissions_intensity), dual-condition filter, and a bar chart comparing qualifying companies vs sector average.',
  },
  {
    id: 3,
    difficulty: 'complex',
    category: 'Year-over-Year',
    name: 'Materials Sector Decarbonization YoY',
    question:
      'For the Materials sector, find every company whose total Scope 1 + Scope 2 emissions fell from 2024 to 2025. Show company, 2024 total, 2025 total, and percentage reduction. Sort by largest reduction.',
    requiresChart: false,
    rubric:
      'Self-join or subquery on company+year, Materials sector filter, scope1+scope2 sum both years, percentage change formula, sorted results.',
  },
  {
    id: 4,
    difficulty: 'complex',
    category: 'Water Stress',
    name: 'Water Intensity vs Withdrawal Outliers',
    question:
      'List the top 5 companies in 2025 ranked by water_intensity. For each, show water_consumption, water_withdrawal, and the ratio of withdrawal to consumption. Plot a grouped bar chart.',
    requiresChart: true,
    rubric:
      'Top 5 by water_intensity, includes water_withdrawal and computed ratio, grouped bar chart with multiple datasets.',
  },
  {
    id: 5,
    difficulty: 'complex',
    category: 'Governance Gap',
    name: 'Board Ahead of Workforce',
    question:
      'Find companies in 2025 where female_board_share exceeds female_employee_share by more than 15 percentage points. List company, sector, both shares, and the gap. Show a bar chart of the gap for top 10.',
    requiresChart: true,
    rubric:
      'Computed gap (female_board_share - female_employee_share) > 15, list with sector, bar chart of gaps for up to 10 companies.',
  },
  {
    id: 6,
    difficulty: 'complex',
    category: 'Multi-Filter ESG',
    name: 'Triple ESG Screen',
    question:
      'Identify companies in 2025 with safety_ltifr = 0, emissions_intensity in the bottom 25% of all companies, and female_employee_share above their sector median. List company, sector, all three metrics, and sector median.',
    requiresChart: false,
    rubric:
      'Requires percentile/subquery for bottom 25% emissions_intensity AND per-sector median female_employee_share, plus LTIFR=0 filter.',
  },
  {
    id: 7,
    difficulty: 'complex',
    category: 'Multi-Year Trends',
    name: 'TCS Scope 1+2 Emissions Trend',
    question:
      'Plot a multi-year line chart of Tata Consultancy Services (TCS) combined Scope 1 + Scope 2 emissions across every year available in the database. Summarize whether emissions are rising or falling.',
    requiresChart: true,
    rubric:
      'Company lookup via LIKE for TCS, sum scope1+scope2 per year, line chart with year on x-axis, trend interpretation in text.',
  },
  {
    id: 8,
    difficulty: 'complex',
    category: 'Sector Analytics',
    name: 'Sector Decarbonization Rate',
    question:
      'For each sector, calculate what percentage of companies reduced emissions_intensity from 2024 to 2025. Rank sectors by decarbonization rate and show a bar chart.',
    requiresChart: true,
    rubric:
      'Per-sector count of companies with lower 2025 vs 2024 emissions_intensity divided by companies with both years, ranked bar chart.',
  },
  {
    id: 9,
    difficulty: 'complex',
    category: 'Intensity Rankings',
    name: 'Worst Carbon per Revenue',
    question:
      'Rank the top 10 companies in 2025 with the highest emissions_intensity among those with total_revenue above 10 billion INR. Show company, sector, emissions_intensity, and revenue. Bar chart required.',
    requiresChart: true,
    rubric:
      'Filter total_revenue > 10e9, sort emissions_intensity DESC, top 10 with sector context, bar chart.',
  },
  {
    id: 10,
    difficulty: 'complex',
    category: 'Circular Economy',
    name: 'Low Recycling Sectors',
    question:
      'Which sectors have an average waste recycling rate (waste_recovered_recycled / waste_generated) below 20% in 2025? List sector, average rate, and company count. Show a bar chart of sector rates.',
    requiresChart: true,
    rubric:
      'Aggregate recycling rate by sector, filter avg < 0.20 or < 20%, show company count per sector, bar chart.',
  },
  {
    id: 11,
    difficulty: 'complex',
    category: 'Triple YoY Improvement',
    name: 'All-Intensity Improvers',
    question:
      'Find companies with data in both 2024 and 2025 that improved ALL three: emissions_intensity, energy_intensity, AND water_intensity (each lower in 2025). List company and the three year-over-year percentage changes.',
    requiresChart: false,
    rubric:
      'Self-join on company for 2024+2025, three separate YoY comparisons all showing improvement, percentage change for each metric.',
  },
  {
    id: 12,
    difficulty: 'complex',
    category: 'Industry Drill-Down',
    name: 'Materials Industry Carbon Comparison',
    question:
      'Within the Materials sector in 2025, compare average emissions_intensity across distinct industries. Rank industries and show a bar chart.',
    requiresChart: true,
    rubric:
      'Filter sector=Materials, GROUP BY industry, AVG(emissions_intensity), ranked bar chart by industry.',
  },
  {
    id: 13,
    difficulty: 'complex',
    category: 'Safety',
    name: 'Safest Sector and Leaders',
    question:
      'Which sector has the lowest average safety_ltifr in 2025? Then list the top 3 companies with the lowest LTIFR in that sector. Include a bar chart of the 3 companies.',
    requiresChart: true,
    rubric:
      'Sector-level AVG(safety_ltifr) to find safest sector, then top 3 companies in that sector by lowest LTIFR, bar chart.',
  },
  {
    id: 14,
    difficulty: 'complex',
    category: 'Composite Scoring',
    name: 'Weighted ESG Scorecard',
    question:
      'Build a composite ESG score for 2025: 40% weight on low emissions_intensity (inverted percentile), 30% on female_employee_share, 30% on safety (inverted LTIFR). Rank top 10 companies, explain the formula, and show a bar chart of scores.',
    requiresChart: true,
    rubric:
      'Must explain weighting methodology, normalize/invert metrics, rank top 10, bar chart of composite scores. SQL or clear computation steps required.',
  },
  {
    id: 15,
    difficulty: 'complex',
    category: 'Peer Benchmarking',
    name: 'Tata Steel vs Materials Peers',
    question:
      'Compare Tata Steel (search company name with LIKE) against the Materials sector average in 2025 for emissions_intensity, energy_intensity, water_intensity, and female_employee_share. Show a grouped bar chart of company vs sector average for all four metrics.',
    requiresChart: true,
    rubric:
      'LIKE search for Tata Steel, sector Materials averages for four metrics, side-by-side comparison table and grouped bar chart with 4 metric pairs.',
  },
];

export const COMPLEX_SUITE_NAME = 'complex_brsr';
