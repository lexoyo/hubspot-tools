const fs = require('fs')
const _ = require('lodash')
const path = require('path')
const express = require('express')
const hubspot = require('@hubspot/api-client')
const bodyParser = require('body-parser')

require('dotenv').config()

const PORT = 3000
const OBJECTS_LIMIT = 30
const CLIENT_ID = process.env.CLIENT_ID
const CLIENT_SECRET = process.env.CLIENT_SECRET
const SCOPES = 'content'
const REDIRECT_URI = `http://localhost:${PORT}/oauth-callback`
const GRANT_TYPES = {
    AUTHORIZATION_CODE: 'authorization_code',
    REFRESH_TOKEN: 'refresh_token',
}

let tokenStore = {}
let waitingAuthCbk

const logResponse = (message, data) => {
    console.log(message, JSON.stringify(data, null, 1))
}

const checkEnv = (req, res, next) => {
    if (_.startsWith(req.url, '/error')) return next()

    if (_.isNil(CLIENT_ID)) return res.redirect('/error?msg=Please set CLIENT_ID env variable to proceed')
    if (_.isNil(CLIENT_SECRET))
        return res.redirect('/error?msg=Please set CLIENT_SECRET env variable to proceed')

    next()
}

const isAuthorized = () => {
    return !_.isEmpty(tokenStore.refreshToken)
}

const isTokenExpired = () => {
    return Date.now() >= tokenStore.updatedAt + tokenStore.expiresIn * 1000
}

const prepareContactsContent = (contacts) => {
    return _.map(contacts, (contact) => {
        const companyName = _.get(contact, 'properties.company') || ''
        const name = getFullName(contact.properties)
        return { id: contact.id, name, companyName }
    })
}

const getFullName = (contactProperties) => {
    const firstName = _.get(contactProperties, 'firstname') || ''
    const lastName = _.get(contactProperties, 'lastname') || ''
    return `${firstName} ${lastName}`
}

const refreshToken = async () => {
    const result = await hubspotClient.oauth.defaultApi.createToken(
        GRANT_TYPES.REFRESH_TOKEN,
        undefined,
        undefined,
        CLIENT_ID,
        CLIENT_SECRET,
        tokenStore.refreshToken,
    )
    tokenStore = result.body
    tokenStore.updatedAt = Date.now()
    console.log('Updated tokens', tokenStore)

    hubspotClient.setAccessToken(tokenStore.accessToken)
}

const handleError = (e, res) => {
    if (_.isEqual(e.message, 'HTTP request failed')) {
        const errorMessage = JSON.stringify(e, null, 2)
        console.error(errorMessage)
        return res.redirect(`/error?msg=${errorMessage}`)
    }

    console.error(e)
    res.redirect(`/error?msg=${JSON.stringify(e, Object.getOwnPropertyNames(e), 2)}`)
}

const app = express()

const hubspotClient = new hubspot.Client()

app.use(express.static('public'))
// app.set('view engine', 'pug')
// app.set('views', path.join(__dirname, 'views'))

app.use(
    bodyParser.urlencoded({
        limit: '50mb',
        extended: true,
    }),
)

app.use(
    bodyParser.json({
        limit: '50mb',
        extended: true,
    }),
)

app.use(checkEnv)

app.get('/', async (req, res) => {
    try {
        if (!isAuthorized()) return res.redirect('/oauth')
        if (isTokenExpired()) await refreshToken()

        // const properties = ['firstname', 'lastname', 'company']
        // Get first contacts page
        // GET /crm/v3/objects/contacts
        // https://developers.hubspot.com/docs/api/crm/contacts
        // console.log('Calling crm.contacts.basicApi.getPage. Retrieve contacts.')
        // const contactsResponse = await hubspotClient.crm.contacts.basicApi.getPage(OBJECTS_LIMIT, undefined, properties)

        // res.render('contacts', { tokenStore, contacts: prepareContactsContent(contactsResponse.body.results) })
        // res.json({ tokenStore, contacts: prepareContactsContent(contactsResponse.body.results) })
      
        try {
          // console.log('=============1', hubspotClient.cms)
          // const result = await hubspotClient.cms.pages.getAll()
          // console.log('=============2')
          // logResponse('Response from API', result)
          const {response, body} = await hubspotClient.apiRequest({
            method: 'GET',
            path: '/content/api/v2/pages',
            body: {
              limit: 100000,
            },
          })
          res.json(body.objects)
        } catch(err) {
          res.json(err)
        }
    } catch (e) {
        handleError(e, res)
    }
})

app.use('/oauth', async (req, res) => {
    // Use the client to get authorization Url
    // https://www.npmjs.com/package/@hubspot/api-client#obtain-your-authorization-url
    console.log('Creating authorization Url')
    const authorizationUrl = hubspotClient.oauth.getAuthorizationUrl(CLIENT_ID, REDIRECT_URI, SCOPES)
    console.log('Authorization Url', authorizationUrl)

    res.redirect(authorizationUrl)
})

app.use('/oauth-callback', async (req, res) => {
    const code = _.get(req, 'query.code')

    // Create OAuth 2.0 Access Token and Refresh Tokens
    // POST /oauth/v1/token
    // https://developers.hubspot.com/docs/api/working-with-oauth
    console.log('Retrieving access token by code:', code)
    const getTokensResponse = await hubspotClient.oauth.defaultApi.createToken(
        GRANT_TYPES.AUTHORIZATION_CODE,
        code,
        REDIRECT_URI,
        CLIENT_ID,
        CLIENT_SECRET,
    )
    logResponse('Retrieving access token result:', getTokensResponse)

    tokenStore = getTokensResponse.body
    tokenStore.updatedAt = Date.now()

    // Set token for the
    // https://www.npmjs.com/package/@hubspot/api-client
    hubspotClient.setAccessToken(tokenStore.accessToken)
    res.redirect('/')
    if(waitingAuthCbk) waitingAuthCbk()
})

app.get('/login', (req, res) => {
    tokenStore = {}
    res.redirect('/')
})

app.get('/refresh', async (req, res) => {
    try {
        if (isAuthorized()) await refreshToken()
        res.redirect('/')
    } catch (e) {
        handleError(e, res)
    }
})

app.get('/error', (req, res) => {
    res.json({ error: req.query.msg })
})

app.use((error, req, res, next) => {
    res.json({ error: error.message })
})

async function getPages() {
  const {response, body} = await hubspotClient.apiRequest({
    method: 'GET',
    path: '/content/api/v2/pages',
    body: {
      limit: 100000,
    },
  })
  fs.writeFileSync('./pages.json', JSON.stringify(body.objects))
  console.log(body.objects.length, 'pages written to ./pages.json')
}
async function updatePages() {
  const data = fs.readFileSync('./pages.json')
  const {response, body} = await hubspotClient.apiRequest({
    method: 'GET',
    path: '/content/api/v2/pages',
    body: {
      limit: 100000,
    },
  })
  console.log('Updated ', body.total, 'pages.')
}
app.listen(PORT, () => {
  waitingAuthCbk = async () => {
    if(fs.existsSync('./pages.json')) {
      updatePages()
    } else {
      getPages()
    }
    process.exit(0)
  }
  console.log('http://localhost:3000/oauth')
})


