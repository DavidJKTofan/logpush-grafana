# Logpush

[Logpush](https://developers.cloudflare.com/logs/about) allows you to _"push logs of Cloudflare's datasets to your cloud service in batches"_.

Today, we can send logs to any HTTP endpoint, choosing a variety of [Log fields or Zone-scoped datasets](https://developers.cloudflare.com/logs/reference/log-fields).

In this post, we will be taking a look at how to send logs to a [Grafana Loki](https://grafana.com/oss/loki/) aggregation system, transforming incoming data from Logpush to a format Grafana Loki understands by using [Cloudflare Workers](https://workers.cloudflare.com/) to do the following:
* Take incoming gzipped Logpush data, unpack it, transform the data;
* Merge all fields into the Loki API format and send it off to the destination.

* * *
* * *

## Create a Worker

Create a new Worker with [Cloudflare Wrangler](https://developers.cloudflare.com/workers/cli-wrangler/commands):
```
wrangler generate PROJECT_NAME
```

Update the `wrangler.toml`:
```
name = "PROJECT_NAME"
type = "webpack"
account_id = "YOUR_ACCOUNT_ID"
workers_dev = true
route = ""
zone_id = ""
usage_model = "unbound"
```

### Dependencies

Depending on your system, you might have to install `node` and `xcode`, as well as (optionally) `jq`:
```
brew install node
xcode-select --install
brew install jq
```

Install the `pako` npm package to decompress incoming files:
```
npm i pako
```

### Index.js

Edit the `index.js` file:
```
import { inflate } from 'pako'

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function transformLogs(obj) {
  let encoding = obj.contentEncoding || undefined
  let payload = obj.payload
  let jobname = obj.job || 'cloudflare_logpush'
  let lokiFormat = {
    streams: [
{
stream: {
          job: jobname,
        },
        values: [],
      },
], }
let log
  if (encoding === 'gzip') {
    payload = await payload.arrayBuffer()
    let data = inflate(payload)
    let logdata = new Uint16Array(data).reduce(function(data, byte) {
      return data + String.fromCharCode(byte)
    }, '')
    log = logdata.split('\n')
  } else {
    // AFAIK this is just required for the very first time of setting up the logpush job since it's not gzipped data?
    let date = new Date().getTime() * 1000000
    log = await payload.json()
    lokiFormat.streams[0].values.push([date, JSON.stringify(log)])
    return lokiFormat
}
  log.forEach(element => {
    let date = element.EdgeStartTimestamp || new Date().getTime() * 1000000
    lokiFormat.streams[0].values.push([date, element])
})
  return lokiFormat
}

async function pushLogs(payload, credentials) {
  // `lokiHost` is an environment variable referencing the loki Server like so:
  // https://logs-prod-us-central1.grafana.net/loki/api/v1/push
  let lokiServer = lokiHost
  let req = await fetch(lokiServer, {
    body: JSON.stringify(payload),
    method: 'POST',
    headers: {
      Authorization: credentials,
      'Content-Type': 'application/json',
    },
})
return req }
async function handleRequest(request) {
  const { searchParams } = new URL(request.url)
  let job = searchParams.get('job')
  const authHeader = request.headers.get('authorization')
  const contentEncoding = request.headers.get('content-encoding')
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify(
        { success: false, message: 'please authenticate and use POST requests' },
        { headers: { 'content-type': 'application/json' } },
), )
}
  if (!authHeader) {
    return new Response(
      JSON.stringify(
        { success: false, message: 'please authenticate' },
        { headers: { 'content-type': 'application/json' } },
), )
  }
  let output = await transformLogs({ payload: await request, contentEncoding, job })
  // TODO: some error checking might be good
  await pushLogs(output, authHeader)
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'content-type': 'application/json' },
  })
}
```

### Grafana Loki Endpoint

Create an environment variable with the URL – such as for example `https://logs-prod-eu-west-0.grafana.net/loki/api/v1/push` – to your [Loki Endpoint](https://grafana.com/docs/loki/latest/api/):
```
wrangler secret put lokiHost
```

Upload the Worker:
```
wrangler publish
```

_Make sure you are getting a **"✨ Success!"** message from the wrangler commands!_

### Log Retention

Check if [Log Retention](https://developers.cloudflare.com/logs/logpull/enabling-log-retention) is enabled:
```
curl -s -H "X-Auth-Email:<YOUR_EMAIL>" -H "X-Auth-Key:<GLOBAL_API_KEY>" GET "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/logs/control/retention/flag" | jq .
```

Enable Log Retention:
```
curl -s -H "X-Auth-Email:<YOUR_EMAIL>" -H "X-Auth-Key:<GLOBAL_API_KEY>" POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/logs/control/retention/flag" -d'{"flag":true}' | jq .
```

Test:
```
curl -sv \
    -H 'X-Auth-Email:<YOUR_EMAIL>' \
    -H 'X-Auth-Key:<GLOBAL_API_KEY>' \
    "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/logs/received?start=2021-08-02T10:00:00Z&end=2021-08-02T10:01:00Z&fields=RayID,EdgeStartTimestamp" | jq .
```

### Logpush Job

Make sure to change the following details:
* <ZONE_ID> (located in the Overview tab for the chosen domain)
* <YOUR_EMAIL> like "YOUR_EMAIL@gmail.com"
* <GLOBAL_API_KEY> like "abcdefghijklmnop_YOUR_API_1234567890" ([Prepare your API tokens or keys](https://developers.cloudflare.com/api/tokens))
* <YOUR_WORKERS_URL> like "https://WORKERS_NAME.YOUR_DOMAIN.workers.dev"
* <YOUR_LOKI_USER_AND_PASSWORD_IN_BASE64> like "dXNlcm5hbWU6cGFzc3dvcmQ=" (you can use [CyberChef](https://gchq.github.io/CyberChef/#recipe=To_Base64('A-Za-z0-9%2B/%3D')&input=dXNlcm5hbWU6cGFzc3dvcmQ))
* <YOUR_LOKI_JOB_NAME> like "grafanacloud-logs"

The last two parameters can be found/edited on your Grafana Dashboard > Configuration > Data Sources > Your Loki > Settings.

cURL request to create a Logpush Job with your choice of [Log fields](https://developers.cloudflare.com/logs/reference/log-fields):
```
curl --location --request POST 'https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/logpush/jobs' \
--header 'X-Auth-Email:<YOUR_EMAIL>' \
--header 'X-Auth-Key:<GLOBAL_API_KEY>' \
--header 'Content-Type:application/json' \
--data-raw '{
    "name": "http",
    "logpull_options": "fields=BotScore,BotScoreSrc,CacheCacheStatus,CacheResponseBytes,CacheResponseStatus,CacheTieredFill,ClientASN,ClientCountry,ClientDeviceType,ClientIP,ClientIPClass,ClientRequestBytes,ClientRequestHost,ClientRequestMethod,ClientRequestPath,ClientRequestProtocol,ClientRequestReferer,ClientRequestURI,ClientRequestUserAgent,ClientSSLCipher,ClientSSLProtocol,ClientSrcPort,ClientXRequestedWith,EdgeColoCode,EdgeColoID,EdgeEndTimestamp,EdgePathingOp,EdgePathingSrc,EdgePathingStatus,EdgeRateLimitAction,EdgeRateLimitID,EdgeRequestHost,EdgeResponseBytes,EdgeResponseCompressionRatio,EdgeResponseContentType,EdgeResponseStatus,EdgeServerIP,EdgeStartTimestamp,FirewallMatchesActions,FirewallMatchesRuleIDs,FirewallMatchesSources,OriginIP,OriginResponseBytes,OriginResponseHTTPExpires,OriginResponseHTTPLastModified,OriginResponseStatus,OriginResponseTime,OriginSSLProtocol,ParentRayID,RayID,SecurityLevel,WAFAction,WAFFlags,WAFMatchedVar,WAFProfile,WAFRuleID,WAFRuleMessage,WorkerCPUTime,WorkerStatus,WorkerSubrequest,WorkerSubrequestCount,ZoneID&timestamps=unixnano",
    "destination_conf": "<YOUR_WORKERS_URL>?header_Authorization=Basic%20<YOUR_LOKI_USER_AND_PASSWORD_IN_BASE64>=&job=<YOUR_LOKI_JOB_NAME>",
    "max_upload_bytes": 5000000,
    "max_upload_records": 1000,
    "dataset": "http_requests",
    "frequency": "high",
    "enabled": true
}' | jq .
```

## Cloudflare Dashboard

If everything worked, a new Logpush Job should appear on your [Cloudflare Dashboard > Analytics > Logs tab](https://dash.cloudflare.com/?to=/:account/:zone/analytics/logs), as well as in Grafana Loki.

* * *

# Analytics Integrations

Additionally, there is a variety of [Analytics Integrations](https://developers.cloudflare.com/fundamentals/data-products/analytics-integrations) to use.

* * *

# Disclaimer

This guide was inspired by a colleague – all crediting goes to him. 🤓

Educational purposes only, and this blog post does not necessarily reflect the opinions of Cloudflare. There are many more aspects to Cloudflare and its products and services – this is merely a brief educational intro. Properly inform yourself, keep learning, keep testing, and feel free to share your learnings and experiences as I do. Hope it was helpful! Images are online and publicly accessible.
