import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';
import dotenv from 'dotenv';
import { getDb, insertReport, deleteReport } from '../src/db.js';
import { resolveXbrlDir } from '../src/paths.js';

dotenv.config();

const XBRL_DIR = resolveXbrlDir();

function guessSectorAndIndustry(companyName, symbol) {
  const name = companyName.toUpperCase();
  const sym = String(symbol || '').toUpperCase();
  
  if (name.includes('BANK') || sym.includes('BANK') || name.includes('FINANCE') || name.includes('INVEST') || name.includes('INSURANCE') || sym.includes('HDFC') || sym.includes('ICICI') || sym.includes('SBIN') || sym.includes('AXIS') || sym.includes('CANBK') || sym.includes('PNB') || sym.includes('IOB') || sym.includes('MAHABANK') || sym.includes('UCOBANK') || sym.includes('CREDITACC') || sym.includes('ANGELONE') || sym.includes('HOMEFIRST')) {
    return { sector: 'Financial Services', industry: 'Banking & Finance' };
  }
  if (name.includes('SOFTWARE') || name.includes('TECHNOLOG') || sym.includes('INFY') || sym.includes('TCS') || sym.includes('WIPRO') || sym.includes('TECHM') || sym.includes('LTIM') || sym.includes('COFORGE') || sym.includes('LTTS') || sym.includes('TATAELXSI') || sym.includes('EMUDHRA')) {
    return { sector: 'Technology', industry: 'Software & IT Services' };
  }
  if (name.includes('PHARMA') || name.includes('LABS') || name.includes('BIOCON') || name.includes('DR. REDDY') || name.includes('CIPLA') || name.includes('LUPIN') || name.includes('SUN PHARMA') || sym.includes('LAURUSLABS') || sym.includes('JBCHEPHARM') || sym.includes('THYROCARE') || sym.includes('VIMTALABS')) {
    return { sector: 'Healthcare', industry: 'Pharmaceuticals & Diagnostics' };
  }
  if (name.includes('CEMENT') || sym.includes('ACC') || sym.includes('AMBUJA') || sym.includes('ULTRACEMCO') || sym.includes('JKCEMENT') || sym.includes('DALBHARAT') || sym.includes('ORIENTCEM') || sym.includes('SAGCEM')) {
    return { sector: 'Materials', industry: 'Cement' };
  }
  if (name.includes('STEEL') || name.includes('METAL') || sym.includes('TATASTEEL') || sym.includes('JSWSTEEL') || sym.includes('SAIL') || sym.includes('HINDZINC') || sym.includes('ALUM') || sym.includes('JINDALSAW') || sym.includes('LLOYDSME')) {
    return { sector: 'Materials', industry: 'Metals & Mining' };
  }
  if (name.includes('POWER') || name.includes('ENERGY') || sym.includes('NTPC') || sym.includes('POWERGRID') || sym.includes('ADANIPOWER') || sym.includes('TATAPOWER')) {
    return { sector: 'Utilities', industry: 'Power Generation & Distribution' };
  }
  if (name.includes('CHEMICAL') || name.includes('ORGANIC') || sym.includes('SRF') || sym.includes('AARTIIND') || sym.includes('GHCL') || sym.includes('HSCL') || sym.includes('ALKYLAMINE') || sym.includes('APCOTEXIND') || sym.includes('EPIGRAL')) {
    return { sector: 'Materials', industry: 'Chemicals' };
  }
  if (name.includes('MOTOR') || name.includes('AUTO') || sym.includes('MARUTI') || sym.includes('TATAMOTORS') || sym.includes('M&M') || sym.includes('HEROMOTOCO') || sym.includes('BAJAJ-AUTO') || sym.includes('SUNDRMFAST') || sym.includes('WHEELS') || sym.includes('GNA')) {
    return { sector: 'Consumer Cyclical', industry: 'Automotive & Components' };
  }
  if (name.includes('PAINTS') || sym.includes('PAINT') || sym.includes('KANSAINER') || sym.includes('BERGER')) {
    return { sector: 'Materials', industry: 'Paints & Coatings' };
  }
  if (name.includes('HOTEL') || name.includes('RESORT') || sym.includes('INDHOTEL') || sym.includes('EIHOTEL')) {
    return { sector: 'Consumer Services', industry: 'Hotels & Tourism' };
  }
  if (name.includes('TELE') || sym.includes('BHARTIARTL') || sym.includes('IDEA') || sym.includes('TTML')) {
    return { sector: 'Telecommunications', industry: 'Telecom Services' };
  }
  if (name.includes('FOOD') || name.includes('BREWER') || name.includes('CONSUMER') || sym.includes('NESTLEIND') || sym.includes('HINDUNILVR') || sym.includes('BRITANNIA') || sym.includes('ITC') || sym.includes('SULA') || sym.includes('GMBREW') || sym.includes('TATACONSUM') || sym.includes('TRENT') || sym.includes('ABDL')) {
    return { sector: 'Consumer Defensive', industry: 'FMCG & Food Processing' };
  }
  if (sym.includes('ADANIENT') || sym.includes('ADANIPORTS')) {
    return { sector: 'Industrials', industry: 'Infrastructure & Ports' };
  }
  if (sym.includes('SWSOLAR') || sym.includes('RELIANCE')) {
    return { sector: 'Energy & Renewables', industry: 'Diversified Energy' };
  }
  
  return { sector: 'Other/Industrial', industry: 'Diversified Industrials' };
}

// Helper to normalize the parsed XML by recursively stripping namespace prefixes
function cleanXmlKeys(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(item => cleanXmlKeys(item));
  }
  
  const cleaned = {};
  for (const key of Object.keys(obj)) {
    const cleanKey = key.replace(/^.*:/, '');
    let value = obj[key];
    
    if (typeof value === 'object' && value !== null) {
      value = cleanXmlKeys(value);
    }
    
    cleaned[cleanKey] = value;
  }
  return cleaned;
}

// Flat map parsed XML into leaf nodes with path, value, unit, and context
function getLeafNodes(obj, prefix = '', list = []) {
  if (typeof obj !== 'object' || obj === null) {
    list.push({ path: prefix, val: obj });
    return list;
  }
  
  if (obj['#text'] !== undefined) {
    list.push({ 
      path: prefix, 
      val: obj['#text'], 
      unit: obj['@_unitRef'] || obj['@_unit'] || '', 
      context: obj['@_contextRef'] || '' 
    });
    return list;
  }
  
  for (const [k, v] of Object.entries(obj)) {
    getLeafNodes(v, prefix ? `${prefix}.${k}` : k, list);
  }
  return list;
}

// Extract company, year, and structured metrics from parsed XML (supports both mock and SEBI standards)
function normalizeReport(parsedXml, filePath = '') {
  const cleaned = cleanXmlKeys(parsedXml);
  
  // 1. Check if this is the mock XML structure
  if (cleaned.BusinessResponsibilityReport || cleaned.CompanyMetadata) {
    const reportRoot = cleaned.BusinessResponsibilityReport || cleaned;
    const metadata = reportRoot.CompanyMetadata || {};
    const envMetrics = reportRoot.EnvironmentalMetrics || {};
    const disclosures = reportRoot.QualitativeDisclosures || {};
    
    const parseMetric = (node) => {
      if (node === undefined || node === null) return null;
      if (typeof node === 'object') {
        const textVal = node['#text'] !== undefined ? node['#text'] : '';
        const numVal = Number(textVal);
        return {
          value: isNaN(numVal) ? textVal : numVal,
          unit: node['@_unit'] || ''
        };
      }
      const numVal = Number(node);
      return {
        value: isNaN(numVal) ? node : numVal,
        unit: ''
      };
    };

    const company = metadata.CompanyName || '';
    const year = parseInt(metadata.ReportingYear) || 2023;
    const filingDate = metadata.FilingDate || '';

    const metrics = {};
    if (envMetrics.Scope1Emissions !== undefined) metrics.scope1_emissions = parseMetric(envMetrics.Scope1Emissions);
    if (envMetrics.Scope2Emissions !== undefined) metrics.scope2_emissions = parseMetric(envMetrics.Scope2Emissions);
    if (envMetrics.Scope3Emissions !== undefined) metrics.scope3_emissions = parseMetric(envMetrics.Scope3Emissions);
    if (envMetrics.FreshWaterConsumption !== undefined) metrics.water_consumption = parseMetric(envMetrics.FreshWaterConsumption);
    if (envMetrics.RenewableEnergyShare !== undefined) metrics.renewable_energy_share = parseMetric(envMetrics.RenewableEnergyShare);

    // Default mock sector/industry
    metrics.sector = 'Mock Sector';
    metrics.industry = 'Mock Industry';

    return [{
      company,
      year,
      filingDate,
      metrics,
      disclosures: {
        notes: disclosures.ProgressNotes || '',
        highlights: disclosures.KeyHighlights || ''
      }
    }];
  }

  // 2. Parse SEBI BRSR Taxonomy XML format
  const leaves = getLeafNodes(cleaned);

  // Find company name
  const companyEl = leaves.find(el => 
    (el.path.includes('NameOfTheListedEntity') || el.path.includes('NameOfTheCompany')) && 
    typeof el.val === 'string' && el.val.trim().length > 0
  );
  const companyName = companyEl ? companyEl.val.trim() : 'Unknown Company';

  // Find start and end dates
  const endCY = leaves.find(el => el.path.includes('DateOfEndOfFinancialYear'))?.val || '';
  const endPY = leaves.find(el => el.path.includes('DateOfEndOfPreviousYear'))?.val || '';

  const currentYear = endCY ? new Date(endCY).getFullYear() : 2026;
  const previousYear = endPY ? new Date(endPY).getFullYear() : 2025;

  const getMetricVal = (key, context) => {
    const match = leaves.find(el => el.path.includes(key) && el.context === context);
    if (match && match.val !== undefined && match.val !== null && match.val !== '') {
      const num = Number(match.val);
      return {
        value: isNaN(num) ? match.val : num,
        unit: match.unit || ''
      };
    }
    return null;
  };

  const resolveYearData = (year, context, filingDate) => {
    const metrics = {};
    
    // Emissions
    const scope1 = getMetricVal('TotalScope1Emissions', context);
    if (scope1) metrics.scope1_emissions = scope1;
    
    const scope2 = getMetricVal('TotalScope2Emissions', context);
    if (scope2) metrics.scope2_emissions = scope2;
    
    const scope3 = getMetricVal('TotalScope3Emissions', context);
    if (scope3) metrics.scope3_emissions = scope3;

    // Energy
    const renewableEnergy = getMetricVal('TotalEnergyConsumedFromRenewableSources', context);
    const nonRenewableEnergy = getMetricVal('TotalEnergyConsumedFromNonRenewableSources', context);
    const totalEnergy = getMetricVal('TotalEnergyConsumedFromRenewableAndNonRenewableSources', context);
    
    if (totalEnergy) metrics.energy_consumption = totalEnergy;
    if (renewableEnergy) metrics.renewable_energy_consumption = renewableEnergy;
    if (nonRenewableEnergy) metrics.non_renewable_energy_consumption = nonRenewableEnergy;
    
    // Calculate renewable energy share
    if (renewableEnergy && totalEnergy && totalEnergy.value > 0) {
      metrics.renewable_energy_share = {
        value: Math.round((renewableEnergy.value / totalEnergy.value) * 10000) / 100,
        unit: '%'
      };
    }

    // Water
    const waterConsumption = getMetricVal('TotalVolumeOfWaterConsumption', context);
    const waterWithdrawal = getMetricVal('TotalVolumeOfWaterWithdrawal', context);
    
    if (waterConsumption) metrics.water_consumption = waterConsumption;
    if (waterWithdrawal) metrics.water_withdrawal = waterWithdrawal;

    // Waste
    const totalWaste = getMetricVal('TotalWasteGenerated', context);
    const plasticWaste = getMetricVal('PlasticWaste', context);
    const eWaste = getMetricVal('EWaste', context);
    
    if (totalWaste) metrics.waste_generated = totalWaste;
    if (plasticWaste) metrics.plastic_waste_generated = plasticWaste;
    if (eWaste) metrics.e_waste_generated = eWaste;

    // Premium Features
    // Sector & Industry
    let symbol = 'Custom';
    if (filePath) {
      const parentDir = path.basename(path.dirname(filePath));
      const grandparentDir = path.basename(path.dirname(path.dirname(filePath)));
      if (parentDir !== 'xbrl' && parentDir !== 'data' && grandparentDir !== 'xbrl') {
        symbol = parentDir;
      }
    }
    const sectorData = guessSectorAndIndustry(companyName, symbol);
    metrics.sector = sectorData.sector;
    metrics.industry = sectorData.industry;

    // Financial Scale (Revenue/Turnover)
    const revVal = getMetricVal('TotalRevenueOfTheCompany', context) || getMetricVal('RevenueFromOperations', context);
    if (revVal) metrics.total_revenue = revVal.value;

    // Intensities
    const emInt = getMetricVal('TotalScope1AndScope2EmissionsIntensityPerRupeeOfTurnover', context);
    if (emInt) metrics.emissions_intensity = emInt.value;
    const enInt = getMetricVal('EnergyIntensityPerRupeeOfTurnover', context);
    if (enInt) metrics.energy_intensity = enInt.value;
    const wtInt = getMetricVal('WaterIntensityPerRupeeOfTurnover', context);
    if (wtInt) metrics.water_intensity = wtInt.value;
    const wsInt = getMetricVal('WasteIntensityPerRupeeOfTurnover', context);
    if (wsInt) metrics.waste_intensity = wsInt.value;

    // Demographics & Diversity
    const empGenderCtx = context === 'DCYMain' ? 'D_Gender_PermanentEmployees' : 'D_Gender_PermanentEmployees_PY';
    const empFemaleCtx = context === 'DCYMain' ? 'D_Female_PermanentEmployees' : 'D_Female_PermanentEmployees_PY';
    
    const totalEmp = getMetricVal('TotalNumberOfEmployeesOrWorkersForMembership', empGenderCtx) || getMetricVal('TotalNumberOfEmployeesOrWorkersForPerformanceAndCareerDevelopment', empGenderCtx);
    const femaleEmp2 = getMetricVal('TotalNumberOfEmployeesOrWorkersForMembership', empFemaleCtx) || getMetricVal('TotalNumberOfEmployeesOrWorkersForPerformanceAndCareerDevelopment', empFemaleCtx);
    
    if (totalEmp && totalEmp.value > 0) {
      metrics.total_employee_count = totalEmp.value;
      if (femaleEmp2) {
        metrics.female_employee_count = femaleEmp2.value;
        metrics.female_employee_share = Math.round((femaleEmp2.value / totalEmp.value) * 10000) / 100;
      }
    } else {
      const femEmp = getMetricVal('AverageNumberOfFemaleEmployeesOrWorkersAtTheBeginningOfTheYearAndAsAtEndOfTheYear', context);
      if (femEmp) {
        metrics.female_employee_count = femEmp.value;
      }
    }

    // Female Board Directors Share
    const femaleBoard = getMetricVal('PercentageOfFemaleBoardOfDirectors', context);
    const totalBoard = getMetricVal('TotalNumberOfBoardOfDirectors', context);
    const femBoard = getMetricVal('NumberOfFemaleBoardOfDirectors', context);
    if (totalBoard?.value > 0) {
      metrics.total_board_count = totalBoard.value;
    }
    if (femBoard?.value >= 0) {
      metrics.female_board_count = femBoard.value;
    }
    if (femaleBoard) {
      const raw = femaleBoard.value;
      // XBRL may store 0.25 (fraction) or 25 (percent) — normalize to percent.
      metrics.female_board_share = raw <= 1 ? Math.round(raw * 10000) / 100 : Math.round(raw * 100) / 100;
    } else if (totalBoard?.value > 0 && femBoard) {
      metrics.female_board_share = Math.round((femBoard.value / totalBoard.value) * 10000) / 100;
    }

    // Safety LTIFR
    const safetyLtifrCtx = context === 'DCYMain' ? 'D_Employees' : 'D_Employees_PY';
    const ltifr = getMetricVal('LostTimeInjuryFrequencyRatePerOneMillionPersonHoursWorked', safetyLtifrCtx);
    if (ltifr) {
      metrics.safety_ltifr = ltifr.value;
    }

    // Recycling rates
    const waterDischarge = getMetricVal('TotalWaterDischargedInKilolitres', context);
    if (waterDischarge) {
      metrics.water_discharge_recycled = waterDischarge.value;
    }
    const wasteRecycled = getMetricVal('WasteRecoveredThroughRecycled', context) || getMetricVal('TotalWasteRecovered', context);
    if (wasteRecycled) {
      metrics.waste_recovered_recycled = wasteRecycled.value;
    }

    // Qualitative disclosures
    const disclosures = {};
    const ghgNotes = leaves.find(el => el.path.includes('DetailsOfProjectRelatedToReducingGreenHouseGasEmissionExplanatoryTextBlock'))?.val || '';
    const wasteNotes = leaves.find(el => el.path.includes('DetailsOfWasteManagementPracticesAdoptedInYourEstablishmentsAndTheStrategyAdoptedByCompanyToReduceUsageOfHazardousAndToxicChemicalsExplanatoryTextBlock'))?.val || '';
    const zldNotes = leaves.find(el => el.path.includes('DetailsOfCoverageAndImplementationIfForZeroLiquidDischargeExplanatoryTextBlock'))?.val || '';

    if (ghgNotes) disclosures.ghg_reduction_projects = ghgNotes;
    if (wasteNotes) disclosures.waste_management_practices = wasteNotes;
    if (zldNotes) disclosures.zero_liquid_discharge_details = zldNotes;

    return {
      company: companyName,
      year,
      filingDate,
      metrics,
      disclosures
    };
  };

  const currentYearData = resolveYearData(currentYear, 'DCYMain', endCY);
  const previousYearData = resolveYearData(previousYear, 'DPYMain', endPY);

  return [currentYearData, previousYearData];
}

export async function processXmlFile(filePath, isCustom = 0) {
  const filename = path.basename(filePath);
  const xmlContent = fs.readFileSync(filePath, 'utf-8');
  
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_'
  });

  const parsed = parser.parse(xmlContent);
  const normalizedYears = normalizeReport(parsed, filePath);

  if (!Array.isArray(normalizedYears) || normalizedYears.length === 0) {
    throw new Error(`Invalid report file: Could not parse report data from ${filename}`);
  }

  const results = [];
  for (const normalized of normalizedYears) {
    const { company, year } = normalized;
    if (!company || !year) {
      console.warn(`Warning: Missing company or year in parsed subset of ${filename}`);
      continue;
    }

    console.log(`Processing XBRL Report: ${company} (${year}) - File: ${filename}`);
    await deleteReport(company, year);
    await insertReport(
      company, 
      year, 
      filename, 
      isCustom, 
      JSON.stringify(normalized),
      normalized.metrics,
      normalized.disclosures
    );
    console.log(`Successfully indexed ${company} (${year}) in database.`);
    results.push({ company, year });
  }
  return results;
}

async function run() {
  const db = await getDb();
  console.log('Database connected.');

  // Delete old records to clear out mock data
  console.log('Clearing old database records...');
  await db.run('DELETE FROM reports');

  if (!fs.existsSync(XBRL_DIR)) {
    fs.mkdirSync(XBRL_DIR, { recursive: true });
    console.log(`Created directory: ${XBRL_DIR}`);
  }

  const files = [];
  function scanDir(dir) {
    if (!fs.existsSync(dir)) return;
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        scanDir(fullPath);
      } else {
        const ext = path.extname(item).toLowerCase();
        if (ext === '.xml' || ext === '.xbrl') {
          files.push(fullPath);
        }
      }
    }
  }
  scanDir(XBRL_DIR);

  if (files.length === 0) {
    console.log(`No XML/XBRL reports found in ${XBRL_DIR}.`);
    return;
  }

  console.log(`Found ${files.length} report(s). Indexing...`);

  for (const filePath of files) {
    try {
      await processXmlFile(filePath, 0); // 0 = standard pre-indexed report
    } catch (err) {
      console.error(`Error processing ${path.basename(filePath)}:`, err.message);
    }
  }

  console.log('Preprocessing completed successfully!');
}

// Run only when executed directly (not when imported by the server)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run();
}
