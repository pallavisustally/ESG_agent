import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { runAgent } from '../src/agent.js';

dotenv.config();

const queries = [
  {
    id: 1,
    category: "Sector Rankings & Resource Intensity",
    name: "Carbon Intensity by Sector",
    question: "Compare the average carbon emissions intensity (emissions_intensity) across all sectors in 2025. Rank the sectors from most carbon-intensive to least, and show a bar chart of the average intensity."
  },
  {
    id: 2,
    category: "Sector Rankings & Resource Intensity",
    name: "Water-Intensive Materials Companies",
    question: "List the top 5 most water-intensive companies (water_intensity) in the Materials sector in 2025. Show their company names, water intensity, and total water consumption. Plot a comparison bar chart."
  },
  {
    id: 3,
    category: "Diversity, Workforce & Governance",
    name: "Female Workforce vs. Board Diversity (Top 10)",
    question: "Find the top 10 companies with the highest female employee share (female_employee_share) in 2025. List their company name, sector, female employee share, and female board share. Show a comparison bar chart of both shares."
  },
  {
    id: 4,
    category: "Diversity, Workforce & Governance",
    name: "Technology Sector Diversity Mapping",
    question: "For all companies in the Technology sector in 2025, compare their female board share (female_board_share) and female employee share (female_employee_share). Show a comparison chart."
  },
  {
    id: 5,
    category: "Carbon Reduction & Energy Trends",
    name: "Tata Power Energy Intensity Trend",
    question: "Analyze the energy intensity trend for TATAPOWER (The Tata Power Company Limited) across all available years in the database. Plot a line chart of the trend."
  },
  {
    id: 6,
    category: "Carbon Reduction & Energy Trends",
    name: "Emission Reductions (Year-over-Year)",
    question: "Find all companies in the Technology sector whose total emissions (Scope 1 + Scope 2) decreased in 2025 compared to 2024. Display the company name, 2024 emissions, 2025 emissions, and the percentage reduction."
  },
  {
    id: 7,
    category: "Safety & Circular Economy",
    name: "Waste Recycling Leaders",
    question: "Which companies in the Materials sector recovered or recycled the highest percentage of their waste in 2025? List the top 5, showing their total waste generated, waste recovered through recycling (waste_recovered_recycled), and the calculated recycling rate. Plot a bar chart."
  },
  {
    id: 8,
    category: "Safety & Circular Economy",
    name: "Safe & Diverse Corporates",
    question: "Find all companies in 2025 that had zero work-related injuries (safety_ltifr = 0) and a female employee share of more than 25%. Show their name, industry, and total revenue."
  },
  {
    id: 9,
    category: "Scale-Based ESG Comparisons",
    name: "High-Revenue vs. Low-Revenue Carbon Intensity",
    question: "Compare the average carbon intensity (emissions_intensity) of high-revenue companies (total_revenue > 50,000,000,000 INR) vs lower-revenue companies in 2025. Show a comparison bar chart."
  }
];

function extractChartJson(text) {
  const chartBlockRegex = /```json-chart\s*([\s\S]*?)\s*```/;
  const match = text.match(chartBlockRegex);
  if (!match) return null;

  try {
    return JSON.parse(match[1].trim());
  } catch (e) {
    return { error: `Invalid JSON syntax: ${e.message}`, rawText: match[1] };
  }
}

function validateChart(chartJson, testId) {
  if (!chartJson) {
    // Some questions don't explicitly require charts, but most do. Let's check which ones.
    const optionalCharts = [6, 8]; // Queries 6 and 8 don't request a chart
    if (optionalCharts.includes(testId)) {
      return { valid: true, message: "No chart requested, none found." };
    }
    return { valid: false, message: "No chart block (```json-chart) found in the response." };
  }

  if (chartJson.error) {
    return { valid: false, message: chartJson.error };
  }

  const requiredKeys = ['type', 'chartType', 'title', 'labels', 'datasets'];
  for (const key of requiredKeys) {
    if (!(key in chartJson)) {
      return { valid: false, message: `Missing required key: "${key}"` };
    }
  }

  if (chartJson.type !== 'chart') {
    return { valid: false, message: `Expected "type" to be "chart", got "${chartJson.type}"` };
  }

  if (!Array.isArray(chartJson.labels) || chartJson.labels.length === 0) {
    return { valid: false, message: "labels must be a non-empty array" };
  }

  if (!Array.isArray(chartJson.datasets) || chartJson.datasets.length === 0) {
    return { valid: false, message: "datasets must be a non-empty array" };
  }

  const labelCount = chartJson.labels.length;
  for (let idx = 0; idx < chartJson.datasets.length; idx++) {
    const dataset = chartJson.datasets[idx];
    if (typeof dataset !== 'object' || dataset === null) {
      return { valid: false, message: `dataset at index ${idx} is not a valid object` };
    }
    if (!('label' in dataset) || !('data' in dataset)) {
      return { valid: false, message: `dataset at index ${idx} is missing "label" or "data"` };
    }
    if (!Array.isArray(dataset.data)) {
      return { valid: false, message: `dataset at index ${idx} "data" must be an array` };
    }
    if (dataset.data.length !== labelCount) {
      return { 
        valid: false, 
        message: `dataset data count (${dataset.data.length}) does not match labels count (${labelCount})` 
      };
    }
  }

  return { valid: true, message: "Chart structure is valid" };
}

async function runEvaluation() {
  console.log("========================================================================");
  console.log("               ESG AI AGENT COMPLEX QUERY EVALUATION                    ");
  console.log("========================================================================");
  console.log(`Starting evaluation at: ${new Date().toISOString()}`);
  console.log(`Using model: ${process.env.OLLAMA_MODEL || 'qwen2.5:7b'}`);
  console.log("========================================================================\n");

  const results = [];

  for (const t of queries) {
    console.log(`[Test ${t.id}] ${t.name}`);
    console.log(`Question: "${t.question}"`);

    const toolCalls = [];
    let sqlExecuted = null;
    let thinkingSteps = 0;
    const startTime = Date.now();

    const progressCallback = (p) => {
      if (p.status === 'thinking') {
        thinkingSteps = p.loop;
      } else if (p.status === 'tool_start') {
        toolCalls.push({ tool: p.tool, message: p.message, start: Date.now() });
        if (p.tool === 'execute_sql_query') {
          // Extract SQL query if possible from progress callback message
          const sqlMatch = p.message.match(/SQL:\s*"([\s\S]*?)"/i);
          if (sqlMatch) {
            sqlExecuted = sqlMatch[1];
          }
        }
      } else if (p.status === 'tool_end') {
        const lastCall = toolCalls[toolCalls.length - 1];
        if (lastCall && lastCall.tool === p.tool) {
          lastCall.durationMs = Date.now() - lastCall.start;
          lastCall.responseSummary = p.message;
        }
      }
    };

    let error = null;
    let agentResponse = null;

    try {
      agentResponse = await runAgent({
        userMessage: t.question,
        onProgress: progressCallback,
        modelName: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
        ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434'
      });
    } catch (err) {
      error = err.message;
      console.error(`  Error running agent: ${err.message}`);
    }

    const duration = Date.now() - startTime;
    
    // Extract and validate chart if successful
    let chartJson = null;
    let chartValidation = { valid: false, message: "No response text available" };

    if (agentResponse && agentResponse.text) {
      chartJson = extractChartJson(agentResponse.text);
      chartValidation = validateChart(chartJson, t.id);
    }

    const passed = !error && (chartValidation.valid);

    const resultRecord = {
      id: t.id,
      name: t.name,
      category: t.category,
      question: t.question,
      durationMs: duration,
      thinkingLoops: thinkingSteps,
      toolCalls,
      sqlExecuted,
      responseText: agentResponse ? agentResponse.text : null,
      chartJson,
      chartValidation,
      passed,
      error
    };

    results.push(resultRecord);

    console.log(`  Duration: ${(duration / 1000).toFixed(2)}s | Steps: ${thinkingSteps} | Tool Calls: ${toolCalls.length}`);
    if (sqlExecuted) {
      console.log(`  SQL Query: ${sqlExecuted.replace(/\n/g, ' ')}`);
    }
    console.log(`  Chart Valid: ${chartValidation.valid ? "✅ YES" : "❌ NO" + (chartJson ? ` (${chartValidation.message})` : "")}`);
    console.log(`  Status: ${passed ? "✅ PASSED" : "❌ FAILED"}\n`);
  }

  // Ensure data directory exists
  const resultsDir = path.resolve('data');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  // Save detailed results JSON
  fs.writeFileSync(
    path.join(resultsDir, 'evaluation_results.json'),
    JSON.stringify(results, null, 2)
  );

  // Generate Markdown Report
  let md = `# ESG Agent Evaluation Report\n\n`;
  md += `Generated on: ${new Date().toLocaleString()}\n`;
  md += `Model tested: \`${process.env.OLLAMA_MODEL || 'qwen2.5:7b'}\`\n\n`;
  
  const total = results.length;
  const passedCount = results.filter(r => r.passed).length;
  const passRate = ((passedCount / total) * 100).toFixed(1);

  md += `## Summary Metrics\n\n`;
  md += `- **Pass Rate**: ${passRate}% (${passedCount}/${total} tests passed)\n`;
  md += `- **Average Duration**: ${(results.reduce((acc, r) => acc + r.durationMs, 0) / total / 1000).toFixed(2)} seconds\n`;
  md += `- **Average Thinking Loops**: ${(results.reduce((acc, r) => acc + r.thinkingLoops, 0) / total).toFixed(1)}\n\n`;

  md += `## Detailed Results\n\n`;
  md += `| ID | Test Name | Category | Duration | Loops | Tools | SQL Executed? | Chart? | Status |\n`;
  md += `|----|-----------|----------|----------|-------|-------|---------------|--------|--------|\n`;

  results.forEach(r => {
    const durStr = `${(r.durationMs / 1000).toFixed(1)}s`;
    const sqlStr = r.sqlExecuted ? '✅' : '❌';
    const chartStr = r.chartValidation.valid ? '✅' : `❌ (${r.chartValidation.message})`;
    const statusStr = r.passed ? '✅ PASSED' : '❌ FAILED';
    md += `| ${r.id} | ${r.name} | ${r.category} | ${durStr} | ${r.thinkingLoops} | ${r.toolCalls.length} | ${sqlStr} | ${chartStr} | ${statusStr} |\n`;
  });

  md += `\n## Failures / Analysis\n\n`;
  const failures = results.filter(r => !r.passed);
  if (failures.length === 0) {
    md += `🎉 All tests passed successfully!\n`;
  } else {
    failures.forEach(f => {
      md += `### Test ${f.id}: ${f.name}\n`;
      md += `- **Error**: ${f.error || 'None'}\n`;
      md += `- **Chart Issue**: ${f.chartValidation.message}\n`;
      if (f.sqlExecuted) {
        md += `- **SQL Executed**: \`${f.sqlExecuted.replace(/\n/g, ' ')}\`\n`;
      }
      if (f.responseText) {
        md += `- **Response Excerpt**:\n  \`\`\`\n  ${f.responseText.slice(0, 300)}...\n  \`\`\`\n`;
      }
      md += `\n`;
    });
  }

  fs.writeFileSync(path.join(resultsDir, 'evaluation_report.md'), md);

  console.log("========================================================================");
  console.log("                         EVALUATION SUMMARY                             ");
  console.log("========================================================================");
  console.log(`Passed: ${passedCount} / ${total} (${passRate}%)`);
  console.log(`Detailed JSON saved to: data/evaluation_results.json`);
  console.log(`Markdown report saved to: data/evaluation_report.md`);
  console.log("========================================================================");
}

runEvaluation().catch(err => {
  console.error("Evaluation crash:", err);
  process.exit(1);
});
