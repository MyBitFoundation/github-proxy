const COMMENTS_PER_PAGE = 10;
const LABELS_PER_PAGE = 10;
const ISSUES_PER_PAGE = 100;
const queryAllIssuesAndComments = `
query {
  organization(login: "MyBitFoundation"){
    repositories(first: 100){
      pageInfo{
        hasNextPage
      }
      edges{
        node{
          name,
          repositoryTopics(first: 10){
            edges{
              node{
                topic{
                  name
                }
              }
            }
          },
          issues(first: ${ISSUES_PER_PAGE}){
            pageInfo{
              hasNextPage
            }
            edges{
              node{
                createdAt,
                state,
                timeline(first: 10){
                  pageInfo{
                    hasNextPage
                  }
                  edges{
                    node{
                      ... on CrossReferencedEvent{
                        url
                        target
                        source{
                          ... on PullRequest{
                            url
                            state
                            author{
                              login
                            }
                          }
                        }
                      }
                    }
                    cursor
                  }
                },
                labels(first: ${LABELS_PER_PAGE}){
                  edges{
                    node{
                      name,
                    },
                  }
                },
                url,
                title,
                number
                comments(first: ${COMMENTS_PER_PAGE}){
                  pageInfo{
                    hasNextPage
                  }
                  edges{
                    node{
                      body,
                      author{
                        login
                      }
                    },
                    cursor
                  }
                }
              },
              cursor
            }
          }
        },
        cursor
      }
    }
  }
}`;

const queryNextPageOfCommentsForIssue = (repoName, issueNumber, cursor) => `
query {
  repository(owner: "MyBitFoundation" name: "${repoName}"){
   issue(number: ${issueNumber}){
      comments(first: ${COMMENTS_PER_PAGE} after: "${cursor}"){
        pageInfo{
          hasNextPage
        }
        edges{
          node{
            author{
              login
            }
            body
          }
          cursor
        }
      }
    }
  }
}`;

const queryNextPageOfIssuesForRepo = (repoName, cursor) => `
query {
  repository(owner: "MyBitFoundation" name: "${repoName}"){
   issues(first: ${ISSUES_PER_PAGE} after: "${cursor}"){
    pageInfo{
      hasNextPage
    }
    edges{
      node{
        createdAt,
        state,
        labels(first: ${LABELS_PER_PAGE}){
          edges{
            node{
              name,
            },
          }
        },
        url,
        title,
        number
        comments(first: ${COMMENTS_PER_PAGE}){
          pageInfo{
            hasNextPage
          }
          edges{
            node{
              body,
              author{
                login
              }
            },
            cursor
          }
        }
      },
      cursor
      }
    }
  }
}
`;

const configForGraphGlRequest = (query) => {
  return{
    url: 'https://api.github.com/graphql',
    method: 'post',
    headers:{
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
    },
    data: {
      query: query
    }
  }
}

const etherscanEndPoint = (txId) => `http://api.etherscan.io/api?module=account&action=tokentx&address=${txId}`;

const addressesUsedToFund = [
  "0x7389c003988802a713af73e82777b1c702077c6f",
  "0x7601387f7bc11f0ec554fe8d068af725781f004d"
]

const mybitTickerCoinmarketcap = 1902;

module.exports = {
  queryAllIssuesAndComments,
  queryNextPageOfCommentsForIssue,
  queryNextPageOfIssuesForRepo,
  configForGraphGlRequest,
  etherscanEndPoint,
  addressesUsedToFund,
  mybitTickerCoinmarketcap
}
