#!/usr/bin/env node

import { getOctokit } from '@actions/github'
const token = process.env.GITHUB_TOKEN
const github = getOctokit(token)

// Mergeable status documentation here:
// https://docs.github.com/en/graphql/reference/enums#mergestatestatus
// https://docs.github.com/en/graphql/reference/enums#mergeablestate

/* 
  This script gets a list of automerge-enabled PRs and sorts them 
  by priority. The PRs with the skip-to-front-of-merge-queue label
  are prioritized first. The rest of the PRs are sorted by the date 
  they were updated. This is basically a FIFO queue, while allowing 
  writers the ability to skip the line when high-priority ships are
  needed but a freeze isn't necessary.
*/

main()

async function main() {
  // Get a list of open PRs and order them from oldest to newest
  const query = `query ($first: Int, $after: String, $firstLabels: Int) {
    organization(login: "github") {
      repository(name: "docs-internal") {
        pullRequests(first: $first, after: $after, states: OPEN, orderBy: {field: UPDATED_AT, direction: ASC}) {
          edges{
            node {
              number
              url
              updatedAt
              mergeable
              mergeStateStatus
              autoMergeRequest {
                enabledBy {
                  login
                }
                enabledAt
              }
              labels (first:$firstLabels){
                nodes {
                  name
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }`

  const queryVariables = {
    first: 100,
    after: null, // when pagination in null it will get first page
    firstLabels: 100,
    headers: {
      // required for the mergeStateStatus enum
      accept: 'application/vnd.github.merge-info-preview+json',
    },
  }
  let hasNextPage = true
  const autoMergeEnabledPRs = []

  // we need to get all the paginated results in the case that
  // there are more than 100 PRs
  while (hasNextPage) {
    const graph = await github.graphql(query, queryVariables)
    const dataRoot = graph.organization.repository.pullRequests
    const pullRequests = dataRoot.edges
    // update pagination variables
    hasNextPage = dataRoot.pageInfo.hasNextPage
    // the endCursor is the start cursor for the next page
    queryVariables.after = dataRoot.pageInfo.endCursor

    const filteredPrs = pullRequests
      // this simplifies the format received from the graphql query to
      // remove the unnecessary nested objects
      .map((pr) => {
        // make the labels object just an array of the label names
        const labelArray = pr.node.labels.nodes.map((label) => label.name)
        pr.node.labels = labelArray
        // return the pr object and ✂️ the node property
        return pr.node
      })
      .filter((pr) => pr.autoMergeRequest !== null)
      .filter((pr) => pr.mergeable === 'MERGEABLE')
      // filter out prs that don't have a calculated mergeable state yet
      .filter((pr) => pr.mergeStateStatus !== 'UNKNOWN')
      // filter out prs that still need a review, have merge conflicts,
      // or have failing ci tests
      .filter((pr) => pr.mergeStateStatus !== 'BLOCKED')
      // **NOTE**: In the future we may want to send slack message to initiators
      // of PRs with the following merge states because these can happen after
      // a PR is green and the automerge is enabled
      .filter((pr) => pr.mergeStateStatus !== 'DIRTY')
      .filter((pr) => pr.mergeStateStatus !== 'UNSTABLE')

    autoMergeEnabledPRs.push(...filteredPrs)
  }

  // Get the list of prs with the skip label so they can
  // be put at the beginning of the list
  const prioritizedPrList = autoMergeEnabledPRs
    .filter((pr) => pr.labels.includes('skip-to-front-of-merge-queue'))
    .concat(autoMergeEnabledPRs.filter((pr) => !pr.labels.includes('skip-to-front-of-merge-queue')))

  const nextInQueue = prioritizedPrList.shift()
  // Update the branch for the next PR in the merge queue
  github.rest.pulls.updateBranch({
    owner: 'github',
    repo: 'docs-internal',
    pull_number: parseInt(nextInQueue.number),
  })

  console.log(`⏱ Total PRs in the merge queue: ${prioritizedPrList.length + 1}`)
  console.log(`🚂 Updated branch for PR #${JSON.stringify(nextInQueue, null, 2)}`)
  console.log(`🚏 Next up in the queue: `)
  console.log(JSON.stringify(prioritizedPrList, null, 2))
}
