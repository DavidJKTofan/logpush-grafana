import { inflate } from 'pako'

addEventListener('fetch', (event) => {
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
    ],
  }

  let log

  if (encoding === 'gzip') {
    payload = await payload.arrayBuffer()

    let data = inflate(payload)
    let logdata = new Uint16Array(data).reduce(function (data, byte) {
      return data + String.fromCharCode(byte)
    }, '')
    log = logdata.split('\n')
  } else {
    let date = new Date().getTime() * 1000000
    log = await payload.json()
    lokiFormat.streams[0].values.push([date, JSON.stringify(log)])
    return lokiFormat
  }

  log.forEach((element) => {
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
  console.log(await req.json())
  return req
}

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
      ),
    )
  }

  if (!authHeader) {
    return new Response(
      JSON.stringify(
        { success: false, message: 'please authenticate' },
        { headers: { 'content-type': 'application/json' } },
      ),
    )
  }
  let output = await transformLogs({ payload: await request, contentEncoding, job })

  // TODO: some error checking might be good
  await pushLogs(output, authHeader)
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'content-type': 'application/json' },
  })
}