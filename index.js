require('dotenv').config();
const express = require('express');
const Promise = require('bluebird');
const cors = require('cors')
const axios = require('axios');
const unit = require('ethjs-unit');
const web3 = require('web3');
const ethereumRegex = require('ethereum-regex');

const {
  queryAllIssuesAndComments,
  queryNextPageOfCommentsForIssue,
  configForGraphGlRequest,
  etherscanEndPoint,
  queryNextPageOfIssuesForRepo} = require('./constants');
const parityContractAbi = require('./parityContractAbi');

console.log(process.env.INFURA_API_KEY)

const web3js = new web3(new web3.providers.HttpProvider(`https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`));
const parityRegistryContract = new web3js.eth.Contract(parityContractAbi, '0x5F0281910Af44bFb5fC7e86A404d0304B0e042F1');

let issues = [];

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/issues', (req, res) => {
    res.send(issues);
})

app.get('/api/issues/resync', (req, res) => {
  processIssues();
  res.send(200);
})

async function getErc20Symbol(address){
  let tokenInfo = await parityRegistryContract.methods
    .fromAddress(address)
    .call()
  return tokenInfo['1'];
}

async function getValueOfContract(contractAddress){
  const {data} = await axios(`http://api.etherscan.io/api?module=account&action=tokentx&address=${contractAddress}`)
  //case where the contract has no transactions
  if(data.status === "0"){
    return -1;
  }
  const valueFromWei = unit.fromWei(data.result[0].value, 'ether');

  let tokenSymbol = data.result[0].tokenSymbol;
  if(tokenSymbol === ''){
    tokenSymbol = await getErc20Symbol(data.result[0].contractAddress);
  }

  return `${tokenSymbol} ${valueFromWei}` ;
}

async function getNextPageOfCommentsOfIssue(reponame, issueNumber, cursor){
  const { data } = await axios(configForGraphGlRequest(queryNextPageOfCommentsForIssue(reponame, issueNumber, cursor)))
  return data;
}

async function getNextPageOfIssuesForRepo(reponame, cursor){
  const { data } = await axios(configForGraphGlRequest(queryNextPageOfIssuesForRepo(reponame, cursor)))
  return data;
}

async function processIssues(){
  //pull all the repositories with issues and comments
  const response = await axios(configForGraphGlRequest(queryAllIssuesAndComments));
  let repos = response.data.data.organization.repositories.edges;

  repos = await Promise.all(repos.map( async ({node}) => {
    const name = node.name;
    let topics = node.repositoryTopics.edges;

    //check if the repo is ddf enabled
    topics = topics.map(({node}) => node.topic.name);
    if(!topics.includes("ddf-enabled")){
      return null;
    }

    let issuesOfRepo = node.issues;
    //handle pagination for issues of a given repo
    while(issuesOfRepo.pageInfo.hasNextPage){
      //pull the next page using the cursor (id of the last issue)
      const nextPageOfIssues = await getNextPageOfIssuesForRepo(name, issuesOfRepo.edges[issuesOfRepo.edges.length - 1].cursor);
      //merge current array of issues for a given repo with the result from the new page of issues
      issuesOfRepo.edges = issuesOfRepo.edges.concat(nextPageOfIssues.data.repository.issues.edges);
      //update the hasNextPage flag with the value of the newly requested page of issues
      issuesOfRepo.pageInfo.hasNextPage = nextPageOfIssues.data.repository.issues.pageInfo.hasNextPage;
    }

    //map all issues to pull information about each issue
    issuesOfRepo = await Promise.all(issuesOfRepo.edges.map( async ({node}) => {
      const {createdAt, state, url, title, number} = node;
      const labels = node.labels.edges.map(({node}) => node.name);
      let comments = node.comments;
      //handle comments pagination - same logic as above
      while(comments.pageInfo.hasNextPage){
        const nextPageComments = await getNextPageOfCommentsOfIssue(name, number, comments.edges[comments.edges.length - 1].cursor);
        comments.edges = comments.edges.concat(nextPageComments.data.repository.issue.comments.edges);
        comments.pageInfo.hasNextPage = nextPageComments.data.repository.issue.comments.pageInfo.hasNextPage;
      }
      comments = comments.edges;
      let contractAddress;
      for(let i = 0; i < comments.length; i++){
        const author = comments[i].node.author.login;
        //pull contract address
        if(author === "status-open-bounty"){
          const match = comments[i].node.body.match(ethereumRegex());
          if(match && match.length > 0){
            contractAddress = match[0];
          }
        }
      }

      const value = contractAddress && await getValueOfContract(contractAddress);

      return{
        createdAt,
        state,
        url,
        title,
        contractAddress,
        name,
        labels,
        value,
      }

    }))
    //remove all issues that don't have a comment with a contract address -> exploitable, need to query etherscan and make sure its a valid contract
    issuesOfRepo = issuesOfRepo.filter(issue => issue.contractAddress)
    return{
      ...issuesOfRepo
    }
  }))

  repos = repos.filter(repo => repo !== null)
  issues = repos;
  return issues;
}

processIssues().then().catch(err => {
  const date = new Date().toString();

  console.log(`${date}  -   Error processing issues: `, err);
  //needs to be discussed - idea being if we have nothing to show to the users then might as well and try to request the information again in case github api goes down for a sec?
  if(issues.length === 0){
    console.log((`${date}  -   Trying to pull issues again in 10 seconds...`))
    setTimeout(processIssues, 10000);
  }
})

const port = process.env.PORT || 9001;
app.listen(port);

console.log(`Express app listening on port ${port}`);
