import { Command } from 'commander';
import {
  BoardConfig,
  JiraClient,
  JiraConfig,
  JiraSearchResponse,
  JiraSprintResponse,
} from '../types';
import { getActiveSprint, getNextSprint, getSprintByName } from '../api/sprints';
import { getActualRemaining } from '../api/issues';
import { calculateDriftScore } from '../metrics/drift';
import { getGroomingMetrics } from '../metrics/grooming';
import { colors } from '../utils/colors';
import {
  formatPlanningReport,
  formatProgressReport,
  formatDigestReport,
} from '../utils/formatting';
import { calculateBusinessDays } from '../utils/dates';

export const setupReportCommand = (program: Command) => {
  program
    .command('report', { isDefault: true }) // Make this the default command
    .description('Generate sprint metrics reports')
    .requiredOption('-b, --board <id>', 'Jira board ID', parseInt)
    .option('--progress', 'Generate a progress report')
    .option('--planning', 'Generate a planning report')
    .option(
      '--digest',
      'Generate a condensed digest of key metrics (implies both progress and planning)',
    )
    .option('-s <n>', 'Sprint name (can be used with both --progress and --planning)')
    .option(
      '-a, --active',
      'Use the active sprint (can be used with both --progress and --planning)',
    )
    .option('-n, --next', 'Use the next sprint (for planning report)')
    .option('-ps <n>', 'Sprint name for progress report (overrides -s for progress)')
    .option('-ls <n>', 'Sprint name for planning report (overrides -s for planning)')
    .option('-pa', 'Use active sprint for progress report (overrides -a for progress)')
    .option('-la', 'Use active sprint for planning report (overrides -a for planning)')
    .option('-ln', 'Use next sprint for planning report (overrides -n for planning)')
    .option('--no-color', 'Disable colored output')
    .option(
      '--time-shift <days>',
      'Shift report time forward or backward by N business days (positive moves forward, negative moves backward)',
      parseInt,
    )
    // Add backward compatibility for the old parameter name
    .option('--future-days <days>', 'DEPRECATED: Use --time-shift instead', parseInt)
    .action(async (options, command) => {
      // Access the parent Command object to get the config and client
      const parent = command.parent as Command & { config: JiraConfig; client: JiraClient };
      const config = parent.config;
      const client = parent.client;

      // If --no-color is specified, clear all color codes
      if (options.color === false) {
        Object.keys(colors).forEach((key) => {
          (colors as any)[key] = '';
        });
      }

      // Handle backward compatibility - prioritize time-shift if both are provided
      if (options.futureDays !== undefined && options.timeShift === undefined) {
        console.log(
          `${colors.yellow}Warning: --future-days is deprecated. Please use --time-shift instead.${colors.reset}`,
        );
        options.timeShift = options.futureDays;
      }

      const boardId = options.board;

      // Find the board configuration
      const boardConfig = config.boards.find((b: BoardConfig) => b.id === boardId);
      if (!boardConfig) {
        console.error(`${colors.red}Board ${boardId} not found in configuration${colors.reset}`);
        return;
      }

      // If digest mode is enabled, it implies both progress and planning
      if (options.digest) {
        options.progress = true;

        // For planning, if no specific option is provided, default to --next
        if (!options.Ls && !options.La && !options.Ln && !options.planning) {
          options.next = true;
        }
      }

      // Determine if we should generate any reports
      // If specific sprint options are specified, implicitly enable those reports
      const generateProgress = options.progress || options.Pa || options.Ps;
      const generatePlanning =
        options.planning || options.La || options.Ls || options.next || options.Ln;

      if (!generateProgress && !generatePlanning) {
        console.log(
          `${colors.yellow}No report type specified. Use --progress and/or --planning flags.${colors.reset}`,
        );
        console.log(`For help, use: jira-metrics report --help`);
        return;
      }

      // Get active sprint if needed
      let activeSprint;
      if (options.active || options.Pa || options.La || options.next) {
        activeSprint = await getActiveSprint(client, boardId);
        if (!activeSprint) {
          console.error(`${colors.red}No active sprint found for board ${boardId}${colors.reset}`);
          return;
        }
      }

      // Get next sprint if needed
      let nextSprint;
      if (options.Ln || (options.digest && options.next)) {
        nextSprint = await getNextSprint(client, boardId);
        if (!nextSprint) {
          console.error(`${colors.red}No future sprints found for board ${boardId}${colors.reset}`);
          return;
        }
      }

      // For digest mode, collect all the metrics and then format them
      if (options.digest) {
        let progressData = null;
        let planningData = null;

        // Get progress data
        if (generateProgress) {
          progressData = await getProgressData(client, boardConfig, options, activeSprint);
        }

        // Get planning data
        if (generatePlanning) {
          planningData = await getPlanningData(
            client,
            boardConfig,
            options,
            activeSprint,
            nextSprint,
          );
        }

        // Format and display the digest
        if (progressData || planningData) {
          const digest = formatDigestReport(boardId, progressData, planningData);
          console.log(digest);
        }
      } else {
        // Regular mode - generate detailed reports
        // Generate progress report
        if (generateProgress) {
          await generateProgressReport(client, boardConfig, options, activeSprint);
        }

        // Generate planning report
        if (generatePlanning) {
          await generatePlanningReport(client, boardConfig, options, activeSprint, nextSprint);
        }
      }
    });
};

// Helper function to get progress data for a report
async function getProgressData(
  client: JiraClient,
  boardConfig: BoardConfig,
  options: any,
  activeSprint: any,
) {
  const boardId = boardConfig.id;

  // Determine which sprint to use for progress report
  let progressSprintName;

  if (options.Ps) {
    progressSprintName = options.Ps;
  } else if (options.Pa && activeSprint) {
    progressSprintName = activeSprint.name;
  } else if (options.s) {
    progressSprintName = options.s;
  } else if (options.active && activeSprint) {
    progressSprintName = activeSprint.name;
  } else {
    console.error(
      `${colors.red}No sprint specified for progress report. Use -s, -ps, -a, or -pa.${colors.reset}`,
    );
    return null;
  }

  // Get sprint data
  const sprint = await getSprintByName(client, boardId, progressSprintName);
  if (!sprint) {
    console.error(
      `${colors.red}Sprint "${progressSprintName}" not found for progress report${colors.reset}`,
    );
    return null;
  }

  // Get remaining work
  const actualRemainingData = await getActualRemaining(client, sprint.name, boardConfig);

  // Parse time shift option (using renamed parameter)
  const timeShift = options.timeShift;

  // Calculate drift score with enhanced breakdown, including time shift if specified
  const {
    initialTotalPoints,
    currentRemainingPoints,
    plannedRemainingPoints,
    driftScore,
    remainingIssues,
    completedIssues,
    completedPoints,
    totalSprintBusinessDays,
    elapsedBusinessDays,
    dailyRate,
    expectedCompletedPoints,
  } = await calculateDriftScore(client, sprint, boardConfig, { timeShift });

  return {
    sprintName: sprint.name,
    driftScore,
    currentRemainingPoints,
    plannedRemainingPoints,
    assigneeWorkload: actualRemainingData.assigneeWorkload,
    unassignedPoints: actualRemainingData.unassignedPoints,
    completedPoints,
    totalPoints: initialTotalPoints,
  };
}

// Helper function to generate progress report
async function generateProgressReport(
  client: JiraClient,
  boardConfig: BoardConfig,
  options: any,
  activeSprint: any,
) {
  // Get progress data (which already includes the drift score calculation)
  const progressData = await getProgressData(client, boardConfig, options, activeSprint);
  if (!progressData) return;

  const boardId = boardConfig.id;

  // Get sprint data again (we need more details for the full report)
  const sprint = await getSprintByName(client, boardId, progressData.sprintName);
  if (!sprint) return;

  // Get remaining work
  const actualRemainingData = await getActualRemaining(client, sprint.name, boardConfig);

  // Get all issues for the report
  const initialTotalPoints = progressData.totalPoints;
  const currentRemainingPoints = progressData.currentRemainingPoints;
  const plannedRemainingPoints = progressData.plannedRemainingPoints;
  const driftScore = progressData.driftScore;
  const completedPoints = progressData.completedPoints;

  // Since getProgressData doesn't return all the detailed data we need,
  // we need to fetch the remaining and completed issues separately

  // Use the predefined story points field from board config
  const storyPointsField = boardConfig.customFields?.storyPoints || 'customfield_10016';

  // Get current remaining issues
  const currentRemainingQuery = encodeURIComponent(`sprint = "${sprint.name}" AND status != Done`);
  const currentRemainingResponse = await client.get<JiraSearchResponse>(
    `/rest/api/3/search?jql=${currentRemainingQuery}&fields=${storyPointsField},status,summary,assignee`,
  );

  const remainingIssues = currentRemainingResponse.data.issues.map((issue) => ({
    key: issue.key,
    summary: issue.fields.summary,
    points: issue.fields[storyPointsField] || 0,
    status: issue.fields.status.name,
    assignee: issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned',
  }));

  // Get completed issues
  const completedQuery = encodeURIComponent(`sprint = "${sprint.name}" AND status = Done`);
  const completedResponse = await client.get<JiraSearchResponse>(
    `/rest/api/3/search?jql=${completedQuery}&fields=${storyPointsField},status,summary,assignee`,
  );

  const completedIssues = completedResponse.data.issues.map((issue) => ({
    key: issue.key,
    summary: issue.fields.summary,
    points: issue.fields[storyPointsField] || 0,
    status: issue.fields.status.name,
    assignee: issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned',
  }));

  // Calculate sprint durations (we need these for the report)
  const startDate = new Date(sprint.startDate);
  const endDate = new Date(sprint.endDate);

  // Get sprint-specific configuration if available
  const sprintConfig = boardConfig.sprints?.[sprint.name];

  // Calculate total and elapsed business days
  const calculatedTotalBusinessDays = calculateBusinessDays(startDate, endDate);
  // Use sprint-specific total business days if provided
  const totalSprintBusinessDays = sprintConfig?.totalBusinessDays ?? calculatedTotalBusinessDays;

  // Calculate elapsed business days
  const currentDate = new Date();
  const elapsedBusinessDays = calculateBusinessDays(startDate, currentDate);

  // Calculate daily rate
  const teamVelocity = sprintConfig?.teamVelocity ?? boardConfig.defaultTeamVelocity;
  let dailyRate;

  if (teamVelocity) {
    dailyRate = teamVelocity / totalSprintBusinessDays;
  } else {
    dailyRate = initialTotalPoints / totalSprintBusinessDays;
  }

  // Round to one decimal place
  dailyRate = Math.round(dailyRate * 10) / 10;

  // Calculate expected completed points
  const expectedCompletedPoints = Math.round(elapsedBusinessDays * dailyRate * 10) / 10;

  // Format and display the report
  const report = formatProgressReport(
    boardId,
    sprint.name,
    initialTotalPoints,
    currentRemainingPoints,
    plannedRemainingPoints,
    driftScore,
    actualRemainingData.assigneeWorkload,
    actualRemainingData.unassignedPoints,
    remainingIssues,
    completedIssues,
    completedPoints,
    totalSprintBusinessDays,
    elapsedBusinessDays,
    dailyRate,
    expectedCompletedPoints,
    startDate,
    endDate,
    currentDate,
    options.timeShift,
  );

  console.log(report);
}

// Helper function to get planning data for a report
async function getPlanningData(
  client: JiraClient,
  boardConfig: BoardConfig,
  options: any,
  activeSprint: any,
  nextSprint?: any,
) {
  const boardId = boardConfig.id;

  // Determine which sprint to use for planning report
  let planSprintName;

  if (options.Ls) {
    planSprintName = options.Ls;
  } else if (options.Ln && nextSprint) {
    // Use the next sprint (already fetched)
    planSprintName = nextSprint.name;
  } else if (options.next) {
    // Use the next sprint after the active sprint
    if (!nextSprint) {
      nextSprint = await getNextSprint(client, boardId);
    }
    if (nextSprint) {
      planSprintName = nextSprint.name;
    } else {
      console.error(`${colors.red}No future sprints found for board ${boardId}${colors.reset}`);
      return null;
    }
  } else if (options.La && activeSprint) {
    planSprintName = activeSprint.name;
  } else if (options.s) {
    planSprintName = options.s;
  } else if (options.active && activeSprint) {
    planSprintName = activeSprint.name;
  } else {
    console.error(
      `${colors.red}No sprint specified for planning report. Use -s, -ls, -a, -la, -n, or -ln.${colors.reset}`,
    );
    return null;
  }

  // Get grooming metrics
  const { groomed, total, issuesByStatus, groomedStatuses, ungroomedStatuses } =
    await getGroomingMetrics(client, planSprintName, boardConfig);

  // Calculate risk score
  const riskScore = total > 0 ? parseFloat((1 - groomed / total).toFixed(2)) : 0;

  // Determine risk level
  let riskLevel = 'Low';
  if (riskScore > 0.66) {
    riskLevel = 'High';
  } else if (riskScore > 0.33) {
    riskLevel = 'Medium';
  }

  return {
    sprintName: planSprintName,
    groomed,
    total,
    riskScore,
    riskLevel,
  };
}

// Helper function to generate planning report
async function generatePlanningReport(
  client: JiraClient,
  boardConfig: BoardConfig,
  options: any,
  activeSprint: any,
  nextSprint?: any,
) {
  const planningData = await getPlanningData(
    client,
    boardConfig,
    options,
    activeSprint,
    nextSprint,
  );
  if (!planningData) return;

  const boardId = boardConfig.id;

  // Get full grooming metrics for the detailed report
  const { groomed, total, issuesByStatus, groomedStatuses, ungroomedStatuses } =
    await getGroomingMetrics(client, planningData.sprintName, boardConfig);

  // Log which sprint is being used for planning (only in full report mode)
  if (options.Ln || options.next) {
    console.log(
      `${colors.blue}Using next sprint for planning: ${planningData.sprintName}${colors.reset}`,
    );
  }

  // Format and display the report
  const report = formatPlanningReport(
    boardId,
    planningData.sprintName,
    groomed,
    total,
    issuesByStatus,
    groomedStatuses,
    ungroomedStatuses,
  );

  console.log(report);
}
