const express = require('express');
const GitHub = require('github-api');
const Promise = require('bluebird');
require('dotenv').config();

const app = express();
app.use(express.json());

const gh = new GitHub({
   token: process.env.GITHUB_TOKEN
});

const nameGetter = (repository) => repository.name

const myBit = gh.getOrganization('MyBitFoundation');
const asyncMyBit = Promise.promisifyAll(myBit);

app.get('/api/repositories', (req, res) => {
  console.log('Retrieving repositories')
  asyncMyBit.getReposAsync()
  .then(repos => res.send(repos.map(nameGetter)))
  .catch(err => res.send(err));
});

const port = process.env.PORT || 9001;
app.listen(port);

console.log(`Express app listening on port ${port}`);