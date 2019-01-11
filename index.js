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
  queryNextPageOfIssuesForRepo,
  queryNextPageOfTimelineForIssue,
  addressesUsedToFund,
  mybitTickerCoinmarketcap,
  etherscanEndPoint,
  refreshTimeInSeconds} = require('./constants');
const parityContractAbi = require('./parityContractAbi');

const web3js = new web3(new web3.providers.HttpProvider(`https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`));
const parityRegistryContract = new web3js.eth.Contract(parityContractAbi, '0x5F0281910Af44bFb5fC7e86A404d0304B0e042F1');

let issues = [];
let fetchingIssues = false;
let numberOfUniqueContributors = 0;
let totalValueOfFund = 0;
let totalPayoutOfFund = 0;
let mybitInUsd = 0;

let rateLimited = false;

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('MyBit Github API Endpoint')
})

app.get('/api/issues', (req, res) => {
    res.send({
      issues,
      numberOfUniqueContributors,
      totalValueOfFund,
      totalPayoutOfFund
    });
})

async function getCurrentUsdPriceOf(ticker){
  const {data} = await axios(`https://api.coinmarketcap.com/v2/ticker/${ticker}/`)
  return data.data.quotes.USD.price;
}

async function getTotalValue(){
  let amountsPerAddress = await Promise.all(addressesUsedToFund.map(async address => {
    const {data} = await axios(etherscanEndPoint(address))
    let sent = 0;
    let received = 0;
    data.result.forEach(tx => {
      //received
      if(tx.to == address){
        received += Number(unit.fromWei(tx.value, 'ether'))
      }
      else{
        sent += Number(unit.fromWei(tx.value, 'ether'))
      }
    })

    return {
      sent,
      received
    }
  }))

  let totalValueTmp = 0;

  amountsPerAddress.forEach(address => {
    totalValueTmp += (address.received - address.sent)
  })

  return Number(totalValueTmp * mybitInUsd);
}

async function getErc20Symbol(address){
  let tokenInfo = await parityRegistryContract.methods
    .fromAddress(address)
    .call()
  return tokenInfo['1'];
}

async function getValueOfContract(contractAddress){
  const {data} = await axios(`http://api.etherscan.io/api?module=account&action=tokentx&address=${contractAddress}`)
  let value = 0, tokenSymbol;
  //case where the contract has no transactions
  if(data.status === "0"){
    return null;
  }
  //pull total value: sum of all transfers sent to the address
  data.result.forEach(tx => {
    if(tx.to === contractAddress){
      value += Number(unit.fromWei(tx.value, 'ether'));
    }
  })

  tokenSymbol = data.result[0].tokenSymbol;
  if(tokenSymbol === ''){
    tokenSymbol = await getErc20Symbol(data.result[0].contractAddress);
  }

  return {
    tokenSymbol,
    value
  }
}

async function getNextPageOfCommentsOfIssue(reponame, issueNumber, cursor){
  const { data } = await axios(configForGraphGlRequest(queryNextPageOfCommentsForIssue(reponame, issueNumber, cursor)))
  return data;
}

async function getNextPageOfTimelineOfIssue(reponame, issueNumber, cursor){
  const { data } = await axios(configForGraphGlRequest(queryNextPageOfTimelineForIssue(reponame, issueNumber, cursor)))
  return data;
}

async function getNextPageOfIssuesForRepo(reponame, cursor){
  const { data } = await axios(configForGraphGlRequest(queryNextPageOfIssuesForRepo(reponame, cursor)))
  return data;
}

async function processIssues(totalFundValue){
  //pull all the repositories with issues and comments
  const response = await axios(configForGraphGlRequest(queryAllIssuesAndComments));
  if(response.data.errors && response.data.errors.length > 0 && response.data.errors[0].type === 'RATE_LIMITED'){
    // wait for 2 hours to see if we are whitelisted
    console.log("We hit the API limit, setting timeout to trigger in 2 hours.")
    rateLimited = true;
    clearInterval(mainInterval);
    setTimeout(mainCycle, 7200 * 1000);
    throw response.data.errors[0].type;
  } else if(rateLimited){
    console.log("We've been whitelisted!");
    mainInterval = setInterval(mainCycle, refreshTimeInSeconds * 1000);
  }
  let repos = response.data.data.organization.repositories.edges;
  let uniqueContributors = {};
  let totalPayout = 0;

  repos = await Promise.all(repos.map( async ({node}) => {
    const repoName = node.name;
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
      const nextPageOfIssues = await getNextPageOfIssuesForRepo(repoName, issuesOfRepo.edges[issuesOfRepo.edges.length - 1].cursor);
      //merge current array of issues for a given repo with the result from the new page of issues
      issuesOfRepo.edges = issuesOfRepo.edges.concat(nextPageOfIssues.data.repository.issues.edges);
      //update the hasNextPage flag with the value of the newly requested page of issues
      issuesOfRepo.pageInfo.hasNextPage = nextPageOfIssues.data.repository.issues.pageInfo.hasNextPage;
    }


    //map all issues to pull information about each issue
    issuesOfRepo = await Promise.all(issuesOfRepo.edges.map( async ({node}) => {
      const {createdAt, url, title, body, number, state} = node;
      const labels = node.labels.edges.map(({node}) => node.name);

      let comments = node.comments, contractAddress, myBitValueFromGitcoin, match;

      //handle comments pagination - same logic as above
      while(comments.pageInfo.hasNextPage){

        const nextPageComments = await getNextPageOfCommentsOfIssue(repoName, number, comments.edges[comments.edges.length - 1].cursor);
        comments.edges = comments.edges.concat(nextPageComments.data.repository.issue.comments.edges);
        comments.pageInfo.hasNextPage = nextPageComments.data.repository.issue.comments.pageInfo.hasNextPage;
      }

      comments = comments.edges;

      for(let i = 0; i < comments.length; i++){
        const author = comments[i].node.author.login;
        //pull contract address
        if(author === "status-open-bounty"){
          match = comments[i].node.body.match(ethereumRegex());
          if(match && match.length > 0){
            contractAddress = match[0];
          }
        }
        if(author === "gitcoinbot") {
          match = comments[i].node.body.match(/[0-9]+.[0-9]+\.*\w/g)
          if(match && match.length > 0){
            myBitValueFromGitcoin = match[0]
          }
          // Placeholder to avoid issue being filtered. Kept so in the future
          // we somehow actually retrieve the contract location in Bounties Network.
          contractAddress = '0x0'
        }
      }

      const valueInfo = isNaN(myBitValueFromGitcoin) ?
        contractAddress && await getValueOfContract(contractAddress) :
        { value: +myBitValueFromGitcoin, tokenSymbol: 'MYB' };

      let merged = false;

      let timeline = node.timeline;
      //handle timeline (list of events) pagination - same logic as above
      while(timeline.pageInfo.hasNextPage){
        const nextPageTimeline = await getNextPageOfTimelineOfIssue(repoName, number, timeline.edges[timeline.edges.length - 1].cursor);
        timeline.edges = timeline.edges.concat(nextPageTimeline.data.repository.issue.timeline.edges);
        timeline.pageInfo.hasNextPage = nextPageTimeline.data.repository.issue.timeline.pageInfo.hasNextPage;
      }
      timeline = timeline.edges;

      //determined whether a referenced PR was merged
      timeline.forEach(({node}) => {
        if(node.source && node.source.state === "MERGED"){
          merged = true;
          //the issue needs to have a valid contract with a value for us to consider this a contributor for the ddf
          if(valueInfo){
            uniqueContributors[node.source.author.login] = 0;
          }
        }
      })

      if(state === "CLOSED" && !merged){
        return null;
      }

      totalPayout = merged && valueInfo ? totalPayout + Number(valueInfo.value * mybitInUsd) : totalPayout;
      totalFundValue = !merged && valueInfo ? totalFundValue + Number(valueInfo.value * mybitInUsd) : totalFundValue;

      return{
        createdAt,
        merged,
        url,
        title,
        body,
        comments,
        contractAddress,
        repoName,
        labels,
        tokenSymbol: valueInfo && valueInfo.tokenSymbol,
        value: valueInfo ? valueInfo.value : 0,
        mybitInUsd: valueInfo ? Number(valueInfo.value * mybitInUsd).toFixed(2) : 0,
      }
    }))

    issuesOfRepo = issuesOfRepo.filter(issue => issue && issue.contractAddress)
    return issuesOfRepo
  }))

  repos = repos.filter(repo => repo !== null)
  let issuesToReturn = [];
  repos.forEach((issuesOfRepo, index) => {
    issuesOfRepo.forEach(issue => issuesToReturn.push(issue));
  });

  numberOfUniqueContributors = Object.keys(uniqueContributors).length;
  totalPayoutOfFund = totalPayout;
  totalValueOfFund = totalFundValue;

  return issuesToReturn;
}

function mainCycle(){
  getCurrentUsdPriceOf(mybitTickerCoinmarketcap)
    .then(val => {
      mybitInUsd=val
      getFundingInfo();
    }).catch(err => {
      console.log(err);
    })
}

function getFundingInfo(){
  getTotalValue()
    .then(fetchAllIssues)
    .catch(err => {
      console.log("error fetching total fund value" + err);
  })
}

function fetchAllIssues(totalFundValue){
  if(fetchingIssues) return;
  fetchingIssues= true;
  processIssues(totalFundValue).then(repos => {
    issues = repos;
    fetchingIssues = false;
    console.log("Fetched all the issues.")
  }).catch(err => {
    fetchingIssues = false;
  })
}
let mainInterval = setInterval(mainCycle, refreshTimeInSeconds * 1000);
mainCycle();

const port = process.env.PORT || 9001;
app.listen(port);

console.log(`Express app listening on port ${port}`);
