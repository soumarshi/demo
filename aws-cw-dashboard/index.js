"use strict";

const {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} = require("@aws-sdk/client-resource-groups-tagging-api");

const {
  CloudWatchClient,
  PutDashboardCommand,
} = require("@aws-sdk/client-cloudwatch");

const taggingClient = new ResourceGroupsTaggingAPIClient({});
const cloudwatchClient = new CloudWatchClient({});

const REGION = process.env.AWS_REGION || "us-east-1";
const CLUSTER_TAG_KEY = process.env.CLUSTER_TAG_KEY || "Team";
const TAG_VALUE = process.env.TAG_VALUE || "NodeJS";
const DASHBOARD_EXEC_PREFIX = process.env.DASHBOARD_EXEC_PREFIX || "Exec-";
const DASHBOARD_DEV_PREFIX = process.env.DASHBOARD_DEV_PREFIX || "Dev-";

async function handler() {
  const mappings = await listTaggedResources(CLUSTER_TAG_KEY, TAG_VALUE);
  const clusters = groupByCluster(mappings, CLUSTER_TAG_KEY);

  for (const clusterName of Object.keys(clusters)) {
    const resources = clusters[clusterName];

    const execWidgets = buildExecutiveWidgets(resources);
    const devWidgets = buildDeveloperWidgets(resources);

    await putDashboard(`${DASHBOARD_EXEC_PREFIX}${clusterName}`, execWidgets);
    await putDashboard(`${DASHBOARD_DEV_PREFIX}${clusterName}`, devWidgets);
    console.log(`Dashboards updated for cluster: ${clusterName}`);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ clusters: Object.keys(clusters) }),
  };
}

/**
 * Run locally: `node index.js`
 * In Lambda: set handler to `index.handler`
 */
exports.handler = handler;

// if (require.main === module) {
//   handler()
//     .then((res) => console.log("Done:", JSON.stringify(res, null, 2)))
//     .catch((err) => {
//       console.error(err);
//       process.exit(1);
//     });
// }

/** -------------------- Tag discovery -------------------- */

async function listTaggedResources(tagKey, tagValue) {
  const out = [];
  let PaginationToken = undefined;

  do {
    const resp = await taggingClient.send(
      new GetResourcesCommand({
        TagFilters: [{ Key: tagKey, Values: [tagValue] }], // any value for this key
        ResourcesPerPage: 50,
        PaginationToken,
      })
    );

    if (resp.ResourceTagMappingList) out.push(...resp.ResourceTagMappingList);
    PaginationToken = resp.PaginationToken;
  } while (PaginationToken);

  return out;
}

function groupByCluster(mappings, clusterTagKey) {
  const clusters = {};

  for (const m of mappings) {
    const arn = m.ResourceARN;
    if (!arn) continue;

    const tags = m.Tags || [];
    const clusterName =
      (tags.find((t) => t.Key === clusterTagKey) || {}).Value || "unknown";

    if (!clusters[clusterName]) {
      clusters[clusterName] = {
        clusterName,
        ecsServices: [],
        albs: [],
      };
    }

    if (arn.includes(":ecs:") && arn.includes("service/")) {
      clusters[clusterName].ecsServices.push(arn);
    } else if (
      arn.includes(":elasticloadbalancing:") &&
      arn.includes("loadbalancer/")
    ) {
      clusters[clusterName].albs.push(arn);
    }
  }

  return clusters;
}

/** -------------------- Widgets -------------------- */

function buildExecutiveWidgets(resources) {
  const widgets = [];
  let y = 0;

  // 1) ALB traffic & errors
  if (resources.albs.length > 0) {
    const metrics = [];
    for (const albArn of resources.albs) {
      const lbDim = extractAlbDimension(albArn);

      metrics.push(["AWS/ApplicationELB", "RequestCount", "LoadBalancer", lbDim]);
      metrics.push([".", "HTTPCode_Target_4XX_Count", ".", "."]);
      metrics.push([".", "HTTPCode_Target_5XX_Count", ".", "."]);
    }

    widgets.push({
      type: "metric",
      x: 0,
      y,
      width: 12,
      height: 6,
      properties: {
        region: REGION,
        view: "timeSeries",
        period: 60,
        stat: "Sum",
        stacked: false,
        title: `${resources.clusterName} – ALB Traffic & Errors`,
        metrics,
      },
    });
    y += 6;
  }

  // 2) ALB latency p95
  if (resources.albs.length > 0) {
    const metrics = [];
    for (const albArn of resources.albs) {
      const lbDim = extractAlbDimension(albArn);
      metrics.push([
        "AWS/ApplicationELB",
        "TargetResponseTime",
        "LoadBalancer",
        lbDim,
        { stat: "p95" },
      ]);
    }

    widgets.push({
      type: "metric",
      x: 0,
      y,
      width: 12,
      height: 6,
      properties: {
        region: REGION,
        view: "timeSeries",
        period: 60,
        title: `${resources.clusterName} – Latency (p95)`,
        metrics,
      },
    });
    y += 6;
  }

  // 3) ECS cluster-level CPU/Mem + tasks (aggregate)
  if (resources.ecsServices.length > 0) {
    const clusterName = extractClusterFromServiceArn(resources.ecsServices[0]);

    const metrics = [
      ["AWS/ECS", "CPUUtilization", "ClusterName", clusterName],
      [".", "MemoryUtilization", ".", "."],
      [".", "RunningTaskCount", ".", "."],
      [".", "DesiredTaskCount", ".", "."],
    ];

    widgets.push({
      type: "metric",
      x: 0,
      y,
      width: 12,
      height: 6,
      properties: {
        region: REGION,
        view: "timeSeries",
        period: 60,
        title: `${resources.clusterName} – ECS Utilization & Tasks`,
        metrics,
      },
    });
  }

  return widgets;
}

function buildDeveloperWidgets(resources) {
  const widgets = [];
  const width = 8;
  const height = 6;

  let x = 0;
  let y = 0;
  let col = 0;

  buildAlbTlsNegotiationErrorsWidget(resources, 0, 0, 12, 6);
  buildEcsClusterTasksWidget(resources.clusterName, 0, 6);

  // Per-service CPU/Mem (3 per row)
  for (const svcArn of resources.ecsServices) {
    const { clusterName, serviceName } = extractClusterAndService(svcArn);

    const metrics = [
      [
        "AWS/ECS",
        "CPUUtilization",
        "ClusterName",
        clusterName,
        "ServiceName",
        serviceName,
      ],
      [".", "MemoryUtilization", ".", ".", ".", "."],
    ];

    widgets.push({
      type: "metric",
      x,
      y,
      width,
      height,
      properties: {
        region: REGION,
        view: "timeSeries",
        period: 60,
        title: `Service – ${serviceName} CPU & Memory`,
        metrics,
      },
    });

    col++;
    if (col === 3) {
      col = 0;
      x = 0;
      y += height;
    } else {
      x += width;
    }
  }

  // Per-service Tasks (next rows)
  if (resources.ecsServices.length > 0) {
    y += height;
    x = 0;
    col = 0;

    for (const svcArn of resources.ecsServices) {
      const { clusterName, serviceName } = extractClusterAndService(svcArn);

      const metrics = [
        [
          "AWS/ECS",
          "RunningTaskCount",
          "ClusterName",
          clusterName,
          "ServiceName",
          serviceName,
        ],
        [".", "DesiredTaskCount", ".", ".", ".", "."],
      ];

      widgets.push({
        type: "metric",
        x,
        y,
        width,
        height,
        properties: {
          region: REGION,
          view: "timeSeries",
          period: 60,
          title: `Service – ${serviceName} Tasks`,
          metrics,
        },
      });

      col++;
      if (col === 3) {
        col = 0;
        x = 0;
        y += height;
      } else {
        x += width;
      }
    }
  }

  // ALB errors + latency (dev view)
  if (resources.albs.length > 0) {
    const metricsErrors = [];
    const metricsLatency = [];

    for (const albArn of resources.albs) {
      const lbDim = extractAlbDimension(albArn);
      metricsErrors.push(["AWS/ApplicationELB", "HTTPCode_Target_4XX_Count", "LoadBalancer", lbDim]);
      metricsErrors.push([".", "HTTPCode_Target_5XX_Count", ".", "."]);

      metricsLatency.push([
        "AWS/ApplicationELB",
        "TargetResponseTime",
        "LoadBalancer",
        lbDim,
        { stat: "p95" },
      ]);
    }

    widgets.push({
      type: "metric",
      x: 0,
      y: y + height,
      width: 12,
      height: 6,
      properties: {
        region: REGION,
        view: "timeSeries",
        period: 60,
        title: `${resources.clusterName} – ALB Errors`,
        metrics: metricsErrors,
      },
    });

    widgets.push({
      type: "metric",
      x: 12,
      y: y + height,
      width: 12,
      height: 6,
      properties: {
        region: REGION,
        view: "timeSeries",
        period: 60,
        title: `${resources.clusterName} – ALB Latency (p95)`,
        metrics: metricsLatency,
      },
    });
  }

  return widgets;
}

function buildEcsClusterTasksWidget(clusterName, x, y) {
  return {
    type: "metric",
    x,
    y,
    width: 12,
    height: 6,
    properties: {
      region: REGION,
      view: "timeSeries",
      period: 60,
      stat: "Sum",
      title: `${clusterName} – ECS Tasks (Running vs Desired)`,
      metrics: [
        [
          {
            id: "run",
            label: "Running (sum across services)",
            expression:
              `SEARCH('{AWS/ECS,ClusterName,ServiceName} MetricName="RunningTaskCount" ClusterName="${clusterName}"', 'Sum', 60)`,
          },
        ],
        [
          {
            id: "des",
            label: "Desired (sum across services)",
            expression:
              `SEARCH('{AWS/ECS,ClusterName,ServiceName} MetricName="DesiredTaskCount" ClusterName="${clusterName}"', 'Sum', 60)`,
          },
        ],
      ],
    },
  };
}


function buildAlbTlsNegotiationErrorsWidget(resources, x, y, width = 12, height = 6) {
  const metrics = [];

  if (resources.albs.length > 0) {
    for (const albArn of resources.albs) {
      const lbDim = extractAlbDimension(albArn);

      metrics.push([
        "AWS/ApplicationELB",
        "ClientTLSNegotiationErrorCount",
        "LoadBalancer",
        lbDim,
      ]);
    }

    return {
      type: "metric",
      x,
      y,
      width,
      height,
      properties: {
        region: REGION,
        view: "timeSeries",
        period: 60,
        stat: "Sum",
        title: `ALB Client TLS Negotiation Errors`,
        metrics,
      },
    };
  }
}


/** -------------------- Dashboard push -------------------- */

async function putDashboard(name, widgets) {
  const body = JSON.stringify({ widgets });

  await cloudwatchClient.send(
    new PutDashboardCommand({
      DashboardName: name,
      DashboardBody: body,
    })
  );

  console.log(`Updated dashboard: ${name}`);
}

/** -------------------- ARN helpers -------------------- */

function extractAlbDimension(albArn) {
  // arn:aws:elasticloadbalancing:region:acct:loadbalancer/app/name/id
  const idx = albArn.indexOf("loadbalancer/");
  if (idx === -1) return albArn;
  return albArn.substring(idx + "loadbalancer/".length);
}

function extractClusterFromServiceArn(serviceArn) {
  // arn:aws:ecs:region:acct:service/clusterName/serviceName
  const parts = serviceArn.split("/");
  return parts[1] || "unknown";
}

function extractClusterAndService(serviceArn) {
  const parts = serviceArn.split("/");
  return {
    clusterName: parts[1] || "unknown-cluster",
    serviceName: parts[2] || "unknown-service",
  };
}
