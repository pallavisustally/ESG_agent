/**
 * 25 ESG agent evaluation questions — easy (1–8), medium (9–17), hard (18–25).
 * Each entry includes rubric text for the judge model.
 */

export const EVALUATION_QUESTIONS = [
  // ── EASY ──────────────────────────────────────────────────────────────────
  {
    id: 1,
    difficulty: 'easy',
    category: 'Basic Lookup',
    name: 'List Available Companies',
    question: 'List all companies currently available in the database.',
    requiresChart: false,
    rubric: 'Response should list company names from the database (via list_companies or SQL). A simple bulleted or numbered list is sufficient. No chart required.',
  },
  {
    id: 2,
    difficulty: 'easy',
    category: 'Basic Lookup',
    name: 'TCS Revenue',
    question: 'What is TCS (Tata Consultancy Services) total revenue in 2025?',
    requiresChart: false,
    rubric: 'Response should state a specific revenue figure in INR for TCS in 2025, sourced from the database. Mentioning the company name and year is required.',
  },
  {
    id: 3,
    difficulty: 'easy',
    category: 'Basic Lookup',
    name: 'HDFC Bank Sector',
    question: 'Which sector does HDFC Bank belong to in 2025?',
    requiresChart: false,
    rubric: 'Response should identify HDFC Bank and state its sector/industry for 2025 (e.g. Financials).',
  },
  {
    id: 4,
    difficulty: 'easy',
    category: 'Diversity',
    name: 'ITC Female Employee Share',
    question: 'What is ITC Limited female employee share (female_employee_share) in 2025?',
    requiresChart: false,
    rubric: 'Response should provide a percentage or decimal value for female_employee_share for ITC in 2025.',
  },
  {
    id: 5,
    difficulty: 'easy',
    category: 'Basic Lookup',
    name: 'Company Count 2025',
    question: 'How many companies have ESG data for the year 2025?',
    requiresChart: false,
    rubric: 'Response should give a numeric count of distinct companies with records for year 2025.',
  },
  {
    id: 6,
    difficulty: 'easy',
    category: 'Emissions',
    name: 'Tata Power Scope 1',
    question: 'What are Tata Power (TATAPOWER) Scope 1 emissions in 2025?',
    requiresChart: false,
    rubric: 'Response should state Scope 1 emissions with units for Tata Power in 2025.',
  },
  {
    id: 7,
    difficulty: 'easy',
    category: 'Rankings',
    name: 'Top 3 by Revenue',
    question: 'List the top 3 companies by total revenue in 2025 with their revenue figures.',
    requiresChart: false,
    rubric: 'Response should name exactly 3 companies ranked by total_revenue descending for 2025, each with a revenue value.',
  },
  {
    id: 8,
    difficulty: 'easy',
    category: 'Diversity',
    name: 'Average Female Board Share',
    question: 'What is the average female board share (female_board_share) across all companies in 2025?',
    requiresChart: false,
    rubric: 'Response should compute or retrieve AVG(female_board_share) for year 2025 and present the result as a percentage or decimal.',
  },

  // ── MEDIUM ────────────────────────────────────────────────────────────────
  {
    id: 9,
    difficulty: 'medium',
    category: 'Sector Rankings',
    name: 'Carbon Intensity by Sector',
    question:
      'Compare the average carbon emissions intensity (emissions_intensity) across all sectors in 2025. Rank sectors from most to least carbon-intensive and show a bar chart.',
    requiresChart: true,
    rubric: 'Response should rank sectors by average emissions_intensity, cite data from SQL, and include a valid json-chart bar chart with sector labels and intensity values.',
  },
  {
    id: 10,
    difficulty: 'medium',
    category: 'Sector Rankings',
    name: 'Water-Intensive Materials Companies',
    question:
      'List the top 5 most water-intensive companies (water_intensity) in the Materials sector in 2025. Show company names, water intensity, and total water consumption. Plot a bar chart.',
    requiresChart: true,
    rubric: 'Response should filter Materials sector, year 2025, sort by water_intensity DESC, show top 5 with names and metrics, and include a bar chart.',
  },
  {
    id: 11,
    difficulty: 'medium',
    category: 'Diversity',
    name: 'Top 10 Female Employee Share',
    question:
      'Find the top 10 companies with the highest female employee share in 2025. List company name, sector, female employee share, and female board share. Show a comparison bar chart.',
    requiresChart: true,
    rubric: 'Response should list 10 companies with both diversity metrics and include a dual-dataset or grouped bar chart comparing the two shares.',
  },
  {
    id: 12,
    difficulty: 'medium',
    category: 'Diversity',
    name: 'Technology Sector Diversity',
    question:
      'For all companies in the Technology sector in 2025, compare female board share and female employee share. Show a comparison chart.',
    requiresChart: true,
    rubric: 'Response should cover Technology sector companies in 2025 with both metrics and a comparison chart (bar or similar).',
  },
  {
    id: 13,
    difficulty: 'medium',
    category: 'Energy Trends',
    name: 'Tata Power Energy Intensity Trend',
    question:
      'Analyze the energy intensity trend for TATAPOWER across all available years. Plot a line chart of the trend.',
    requiresChart: true,
    rubric: 'Response should show Tata Power energy_intensity over multiple years with a line chart. Years should be on the x-axis.',
  },
  {
    id: 14,
    difficulty: 'medium',
    category: 'Circular Economy',
    name: 'Waste Recycling Leaders',
    question:
      'Which companies in the Materials sector recovered or recycled the highest percentage of waste in 2025? List top 5 with waste generated, waste recovered, and recycling rate. Plot a bar chart.',
    requiresChart: true,
    rubric: 'Response should compute recycling rate (recovered/generated), rank top 5 in Materials 2025, and include a bar chart.',
  },
  {
    id: 15,
    difficulty: 'medium',
    category: 'Safety & Diversity',
    name: 'Safe & Diverse Corporates',
    question:
      'Find all companies in 2025 with zero work-related injuries (safety_ltifr = 0) and female employee share above 25%. Show name, industry, and total revenue.',
    requiresChart: false,
    rubric: 'Response should filter safety_ltifr = 0 AND female_employee_share > 25 for 2025 and list matching companies with industry and revenue. No chart required.',
  },
  {
    id: 16,
    difficulty: 'medium',
    category: 'Scale Comparisons',
    name: 'High vs Low Revenue Carbon Intensity',
    question:
      'Compare average carbon intensity of high-revenue companies (total_revenue > 50 billion INR) vs lower-revenue companies in 2025. Show a comparison bar chart.',
    requiresChart: true,
    rubric: 'Response should segment by revenue threshold, compare average emissions_intensity for both groups in 2025, and show a bar chart with two bars.',
  },
  {
    id: 17,
    difficulty: 'medium',
    category: 'Sector Comparisons',
    name: 'Financials vs Technology Energy Intensity',
    question:
      'Compare average energy intensity between Financials and Technology sectors in 2025. Show a bar chart.',
    requiresChart: true,
    rubric: 'Response should compute AVG(energy_intensity) for Financials and Technology in 2025 and present a two-bar comparison chart.',
  },

  // ── HARD ──────────────────────────────────────────────────────────────────
  {
    id: 18,
    difficulty: 'hard',
    category: 'Year-over-Year',
    name: 'Technology Emission Reductions',
    question:
      'Find all Technology sector companies whose total emissions (Scope 1 + Scope 2) decreased in 2025 compared to 2024. Show company name, 2024 emissions, 2025 emissions, and percentage reduction.',
    requiresChart: false,
    rubric: 'Response requires YoY comparison (self-join or subquery), Technology sector filter, and percentage reduction calculation for each qualifying company.',
  },
  {
    id: 19,
    difficulty: 'hard',
    category: 'Multi-Metric YoY',
    name: 'Dual Improvement Leaders',
    question:
      'Which companies improved both emissions intensity (lower in 2025 than 2024) AND increased female board share from 2024 to 2025? List company name, both metrics for each year, and the changes.',
    requiresChart: false,
    rubric: 'Response must compare two years for two different metrics per company and list only companies improving on BOTH dimensions.',
  },
  {
    id: 20,
    difficulty: 'hard',
    category: 'Sector Analytics',
    name: 'Best Sector Recycling Rate',
    question:
      'Which sector has the highest average waste recycling rate in 2025? Show the calculation (waste_recovered_recycled / waste_generated) per sector and rank all sectors. Include a bar chart.',
    requiresChart: true,
    rubric: 'Response should aggregate recycling rate by sector, explain the formula, rank sectors, and include a bar chart of sector recycling rates.',
  },
  {
    id: 21,
    difficulty: 'hard',
    category: 'Relative Performance',
    name: 'High Carbon Low Safety Outliers',
    question:
      'Identify companies in 2025 that have above-average emissions intensity but below-average safety LTIFR within their own sector. List company, sector, both values, and sector averages.',
    requiresChart: false,
    rubric: 'Response requires per-sector averages and filtering companies where emissions_intensity > sector avg AND safety_ltifr < sector avg. Must show sector context.',
  },
  {
    id: 22,
    difficulty: 'hard',
    category: 'Year-over-Year',
    name: 'Water Intensity Reduction Leaders',
    question:
      'Find the top 5 companies that reduced water intensity the most from 2024 to 2025. Show company name, 2024 value, 2025 value, and percentage reduction. Plot a bar chart.',
    requiresChart: true,
    rubric: 'Response needs YoY water_intensity comparison across all companies, top 5 by largest decrease, percentage change, and a bar chart.',
  },
  {
    id: 23,
    difficulty: 'hard',
    category: 'Correlation Analysis',
    name: 'Revenue vs Emissions Intensity',
    question:
      'Analyze whether high-revenue companies tend to have lower emissions intensity in 2025. Compare average emissions intensity for the top 10 vs bottom 10 companies by revenue and discuss the finding.',
    requiresChart: true,
    rubric: 'Response should rank by revenue, compare top-10 vs bottom-10 average emissions_intensity, state a conclusion, and include a comparison chart.',
  },
  {
    id: 24,
    difficulty: 'hard',
    category: 'Multi-Year Trends',
    name: 'Female Board Share Trend — Top 5 Revenue',
    question:
      'Plot a multi-year line chart of female board share for the top 5 companies by revenue in 2025, showing trends across all available years.',
    requiresChart: true,
    rubric: 'Response should identify top 5 by 2025 revenue, fetch female_board_share across years for each, and render a multi-line chart with year on x-axis.',
  },
  {
    id: 25,
    difficulty: 'hard',
    category: 'Composite Scoring',
    name: 'ESG Balanced Leaders',
    question:
      'Rank the top 10 companies in 2025 that best balance low emissions intensity, high female employee share (above 20%), and zero LTIFR. Explain your ranking methodology and show a bar chart of a composite score.',
    requiresChart: true,
    rubric: 'Response must define a composite scoring method, filter for female_employee_share > 20% and safety_ltifr = 0, rank top 10 by balanced ESG performance, and include a bar chart of scores.',
  },
];

export const DIFFICULTY_ORDER = ['easy', 'medium', 'hard'];
