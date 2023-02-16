const fs = require('fs');
const axios = require('axios');
const stream = require('stream');
const util = require('util');
const { program } = require('commander');
const commander = require('commander');

const finished = util.promisify(stream.finished);

// -------------------- CONSTANTS --------------------

const GITHUB_API_BASEURL = 'https://api.github.com';
const NEUTRON_ORG = 'neutron-org';
const STORAGE_ADDR_BASE =
  'https://storage.googleapis.com/neutron-contracts/neutron-org';
const DEFAULT_BRANCH = 'neutron_audit_informal_17_01_2023';
const DEFAULT_DIR = 'contracts';
const CI_TOKEN_ENV_NAME = 'PAT_TOKEN';

// -------------------- UTILS --------------------

// eslint-disable-next-line @typescript-eslint/no-empty-function
let verboseLog = () => {};

async function downloadFile(fileUrl, outputLocationPath) {
  verboseLog(`Downloading file by url: ${fileUrl}`);
  const writer = fs.createWriteStream(outputLocationPath);
  return axios({
    method: 'get',
    url: fileUrl,
    responseType: 'stream',
  }).then((response) => {
    response.data.pipe(writer);
    return finished(writer);
  });
}

const wait = async (seconds) =>
  new Promise((r) => {
    setTimeout(() => r(true), 1000 * seconds);
  });

const getWithAttempts = async (getFunc, readyFunc, numAttempts = 20) => {
  let error = null;
  let data = null;
  const delay = 10;
  while (numAttempts > 0) {
    numAttempts--;
    try {
      data = await getFunc();
      if (await readyFunc(data)) {
        return data;
      }
    } catch (e) {
      error = e;
    }
    console.log(`${numAttempts * delay} seconds left`);
    await wait(delay);
  }
  throw error != null
    ? error
    : new Error(
        'getWithAttempts: no attempts left. Latest get response: ' +
          (data === Object(data) ? JSON.stringify(data) : data).toString(),
      );
};

// -------------------- GIT/GITHUB --------------------

const getLatestCommit = async (repo_name, branch_name) => {
  const url = `${GITHUB_API_BASEURL}/repos/${NEUTRON_ORG}/${repo_name}/branches/${branch_name}`;
  verboseLog(`Getting latest commit by url:\n${url}`);
  const resp = (await axios.get(url)).data;
  return resp['commit']['sha'];
};

const triggerContractsBuilding = async (repo_name, commit_hash, ci_token) => {
  if (!ci_token) {
    console.log('No CI token provided');
    throw new Error("CI token isn't provided, can't trigger the build");
  }

  const workflow_id = await getBuildWorkflowId(repo_name);
  verboseLog(`Using workflow id ${workflow_id}`);
  const url = `${GITHUB_API_BASEURL}/repos/${NEUTRON_ORG}/${repo_name}/actions/workflows/${workflow_id}/dispatches`;
  const resp = await axios.post(
    url,
    {
      ref: 'main',
      inputs: {
        branch: commit_hash,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${ci_token}`,
      },
    },
  );
  if (resp.status !== 204) {
    throw new Error('Wrong return code');
  }
};

const getBuildWorkflowId = async (repo_name) => {
  const url = `${GITHUB_API_BASEURL}/repos/${NEUTRON_ORG}/${repo_name}/actions/workflows`;
  const resp = (await axios.get(url)).data;
  return resp['workflows'].find((x) => x['path'].includes('build.yml'))['id'];
};

// -------------------- STORAGE --------------------

const getChecksumsTxt = async (repo_name, commit_hash, ci_token) => {
  const url = `${STORAGE_ADDR_BASE}/${repo_name}/${commit_hash}/checksums.txt`;
  verboseLog(`Getting checksums by url: ${url}`);

  try {
    return (await axios.get(url)).data;
  } catch (error) {
    console.log('No checksum file found, launching the building workflow');
    try {
      await triggerContractsBuilding(repo_name, commit_hash, ci_token);
    } catch (error) {
      // the error is printed only in verbose mode because it can expose PAT token otherwise
      verboseLog(error);
      throw new Error('Error during build triggering');
    }
    const attempts_number = (15 * 60) / 10;
    return (
      await getWithAttempts(
        async () => axios.get(url),
        async (response) => response.status === 200,
        attempts_number,
      )
    ).data;
  }
};

const parseChecksumsTxt = (checksums_txt) => {
  const regex = /\S+\.wasm/g;
  return checksums_txt.match(regex);
};

const downloadContracts = async (
  repo_name,
  contracts_list,
  commit_hash,
  dest_dir,
) => {
  const dir_name = repo_name;
  let promises = [];
  for (const element of contracts_list) {
    const url = `${STORAGE_ADDR_BASE}/${dir_name}/${commit_hash}/${element}`;
    const file_path = `${dest_dir}/${element}`;

    promises.push(downloadFile(url, file_path));
  }
  await Promise.all(promises);
};

// -------------------- MAIN --------------------

async function downloadArtifacts(
  repo_name,
  branch_name,
  commit_hash,
  dest_dir,
  ci_token,
) {
  console.log(`Downloading artifacts for ${repo_name} repo`);

  if (commit_hash) {
    console.log(`Using specified commit: ${commit_hash}`);
  } else {
    commit_hash = await getLatestCommit(repo_name, branch_name);
    console.log(`Using branch ${branch_name}`);
    console.log(`The latest commit is: ${commit_hash}`);
  }

  verboseLog('Downloading checksum.txt');
  const checksums_txt = await getChecksumsTxt(repo_name, commit_hash, ci_token);

  if (!checksums_txt) {
    console.log('Respective checksum.txt is not found in storage');
    return;
  }

  const contracts_list = parseChecksumsTxt(checksums_txt);

  const contracts_list_pretty = contracts_list.map((c) => `\t${c}`).join('\n');
  console.log(`Contracts to be downloaded:\n${contracts_list_pretty}`);

  await downloadContracts(repo_name, contracts_list, commit_hash, dest_dir);

  console.log(`Contracts are downloaded to the "${dest_dir}" dir\n`);
}

async function main() {
  program
    .option('-b, --branch [name]', 'branch to download')
    .option('-c, --commit [hash]', 'commit to download')
    .option(
      '-d, --dir [name]',
      'destination directory to put contracts artifacts into',
    )
    .option('-v, --verbose', 'verbose output');

  program.addArgument(
    new commander.Argument(
      '<repo...>',
      'contracts repos to download artifacts for',
    ),
  );

  program.addHelpText(
    'after',
    `
Environment vars:
  ${CI_TOKEN_ENV_NAME}\t\tCI token to trigger building if needed`,
  );

  program.parse();

  const ci_token = process.env[CI_TOKEN_ENV_NAME];

  const options = program.opts();
  const dest_dir = options.dir || DEFAULT_DIR;
  const repos_to_download = program.args;

  let branch_name = options.branch;
  const commit_hash = options.commit;
  if (branch_name && commit_hash) {
    console.log(
      'Both branch and commit hash are specified, exiting. \
Please specify only a single thing.',
    );
    return;
  }
  if (!branch_name && !commit_hash) {
    branch_name = DEFAULT_BRANCH;
  }

  if (options.verbose) {
    verboseLog = console.log;
  }

  for (const value of repos_to_download) {
    await downloadArtifacts(
      value,
      branch_name,
      commit_hash,
      dest_dir,
      ci_token,
    );
  }
}

main().then();
