import { Command, flags } from '@oclif/command';
import { sendMany, Recipient, isNormalInteger, getAddress } from '../builder';
import {
  StacksMocknet,
  StacksMainnet,
  StacksTestnet,
  StacksNetwork,
} from '@stacks/network';
import {
  broadcastTransaction,
  ChainID,
  validateStacksAddress,
} from '@stacks/transactions';
import { STXPostCondition } from '@stacks/transactions/dist/transactions/src/postcondition';

type NetworkString = 'mocknet' | 'mainnet' | 'testnet';

const DEFAULT_TESTNET_CONTRACT =
  'STR8P3RD1EHA8AA37ERSSSZSWKS9T2GYQFGXNA4C.send-many-memo';
const DEFAULT_MAINNET_CONTRACT =
  'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.send-many-memo';

export class SendManyMemo extends Command {
  static description = `Execute a bulk STX transfer, with memos attached.
  The bulk transfer is executed in a single transaction by invoking a \`contract-call\` on the "send-many-memo" contract.

  The default contracts can be found below:

  Testnet: https://explorer.stacks.co/txid/${DEFAULT_TESTNET_CONTRACT}?chain=testnet
  Mainnet: https://explorer.stacks.co/txid/${DEFAULT_MAINNET_CONTRACT}?chain=mainnet

  Example usage:

  \`\`\`
  npx stx-bulk-transfer send-many-memo STADMRP577SC3MCNP7T3PRSTZBJ75FJ59JGABZTW,100,hello ST2WPFYAW85A0YK9ACJR8JGWPM19VWYF90J8P5ZTH,50,memo2 -k my_private_key -n testnet -b
  \`\`\`
  `;
  // allow infinite arguments
  static strict = false;

  static flags = {
    help: flags.help({ char: 'h' }),
    privateKey: flags.string({
      char: 'k',
      description: 'Your private key',
      required: true,
    }),
    broadcast: flags.boolean({
      char: 'b',
      default: false,
      description:
        'Whether to broadcast this transaction. Omitting this flag will not broadcast the transaction.',
    }),
    network: flags.string({
      char: 'n',
      description: 'Which network to broadcast this to',
      options: ['mocknet', 'testnet', 'mainnet'],
      default: 'testnet',
    }),
    nodeUrl: flags.string({
      required: false,
      char: 'u',
      description:
        'A default node URL will be used based on the `network` option. Use this flag to manually override.',
    }),
    quiet: flags.boolean({
      char: 'q',
      default: false,
      description: `
Reduce logging from this command. If this flag is passed with the broadcast (-b) flag,
only the transaction ID will be logged. If the quiet flagged is passed without broadcast, 
only the raw transaction hex will be logged.
`,
    }),
    jsonOutput: flags.boolean({
      char: 'j',
      default: false,
      description: 'Output data in JSON format',
    }),
    contractAddress: flags.string({
      char: 'c',
      description:
        'Manually specify the contract address for send-many-memo. If omitted, default contracts will be used.',
    }),
    nonce: flags.integer({
      description: 'Optionally specify a nonce for this transaction',
    }),
  };

  static args = [
    {
      name: 'recipients',
      description: `
A set of recipients in the format of "address,amount_ustx,memo". Memo is optional.
Example: STADMRP577SC3MCNP7T3PRSTZBJ75FJ59JGABZTW,100,memo ST2WPFYAW85A0YK9ACJR8JGWPM19VWYF90J8P5ZTH,50
      `,
    },
  ];

  getNetwork() {
    const { flags } = this.parse(SendManyMemo);
    const networks = {
      mainnet: StacksMainnet,
      testnet: StacksTestnet,
      mocknet: StacksMocknet,
    };

    return networks[flags.network as NetworkString];
  }

  getContract(network: StacksNetwork) {
    return network.chainId === ChainID.Mainnet
      ? DEFAULT_MAINNET_CONTRACT
      : DEFAULT_TESTNET_CONTRACT;
  }

  async run() {
    const { argv, flags } = this.parse(SendManyMemo);

    const recipients: Recipient[] = argv.map(arg => {
      const [address, amount, memo] = arg.split(',');
      if (!validateStacksAddress(address)) {
        throw new Error(`${address} is not a valid STX address`);
      }
      if (!isNormalInteger(amount)) {
        throw new Error(`${amount} is not a valid integer.`);
      }
      return {
        address,
        amount,
        memo,
      };
    });

    const networkClass = this.getNetwork();
    if (!networkClass) {
      throw new Error('Unable to get network');
    }
    const network = new networkClass();
    if (flags.nodeUrl) {
      network.coreApiUrl = flags.nodeUrl;
    }

    if (network instanceof StacksMocknet && !flags.contractAddress) {
      throw new Error('Must manually specify contract address for mocknet');
    }
    const contractIdentifier =
      flags.contractAddress || this.getContract(network);

    const tx = await sendMany({
      recipients,
      network,
      senderKey: flags.privateKey,
      contractIdentifier,
      nonce: flags.nonce,
      withMemo: true,
    });

    const verbose = !flags.quiet;

    let outputEntries: Record<
      string,
      string | boolean | Record<string, string>[]
    > = {};

    outputEntries = {
      recipients: recipients.map(r => ({
        address: r.address,
        amount: r.amount,
        memo: r.memo || '',
      })),
      fee: tx.auth.getFee().toString(),
      nonce: tx.auth.spendingCondition?.nonce.toString() || '?',
      contract: contractIdentifier,
      sender: getAddress(flags.privateKey, network),
      totalAmount: (tx.postConditions
        .values as STXPostCondition[])[0].amount.toString(),
      transactionHex: tx.serialize().toString('hex'),
    };

    let broadcastFailed = false;
    if (flags.broadcast) {
      const result = await broadcastTransaction(tx, network);
      if (typeof result === 'string') {
        if (verbose) {
          outputEntries['success'] = true;
          outputEntries['transactionId'] = result;
          if (!(network instanceof StacksMocknet)) {
            const explorerLink = `https://explorer.stacks.co/txid/0x${result}`;
            outputEntries['explorerLink'] = `${explorerLink}?chain=${
              network.chainId === ChainID.Mainnet ? 'mainnet' : 'testnet'
            }`;
          }
        } else {
          if (flags.jsonOutput) {
            console.log(JSON.stringify({ transactionId: result.toString() }));
          } else {
            console.log(result.toString());
          }
        }
      } else {
        broadcastFailed = true;
        outputEntries['success'] = false;
        outputEntries['error'] = JSON.stringify(result, null, 2);
      }
    } else if (flags.quiet) {
      if (flags.jsonOutput) {
        console.log(
          JSON.stringify({ transactionHex: tx.serialize().toString('hex') })
        );
      } else {
        console.log(tx.serialize().toString('hex'));
      }
    }

    if (verbose) {
      if (flags.jsonOutput) {
        this.log(JSON.stringify(outputEntries, null, 2));
      } else {
        for (const [key, value] of Object.entries(outputEntries)) {
          if (Array.isArray(value)) {
            this.log(`${key}:`);
            value.forEach(obj => {
              Object.entries(obj).forEach(([k, v]) => {
                this.log(`  ${k}: ${v}`);
              });
              this.log('  ----------');
            });
          } else {
            this.log(`${key}: ${value}`);
          }
        }
      }
    }

    if (broadcastFailed) {
      process.exit(1);
    }
  }
}
