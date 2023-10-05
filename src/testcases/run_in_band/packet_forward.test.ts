import Long from 'long';
import {
  cosmosWrapper,
  COSMOS_DENOM,
  IBC_RELAYER_NEUTRON_ADDRESS,
  NEUTRON_DENOM,
  TestStateLocalCosmosTestNet,
  types,
} from '@neutron-org/neutronjsplus';

import config from '../../config.json';

describe('Neutron / Simple', () => {
  let testState: TestStateLocalCosmosTestNet;
  let neutronChain: cosmosWrapper.CosmosWrapper;
  let gaiaChain: cosmosWrapper.CosmosWrapper;
  let neutronAccount: cosmosWrapper.WalletWrapper;
  let gaiaAccount: cosmosWrapper.WalletWrapper;
  let gaiaAccount2: cosmosWrapper.WalletWrapper;
  let contractAddress: string;

  beforeAll(async () => {
    cosmosWrapper.registerCodecs();

    testState = new TestStateLocalCosmosTestNet(config);
    await testState.init();
    neutronChain = new cosmosWrapper.CosmosWrapper(
      testState.sdk1,
      testState.blockWaiter1,
      NEUTRON_DENOM,
    );
    neutronAccount = new cosmosWrapper.WalletWrapper(
      neutronChain,
      testState.wallets.qaNeutron.genQaWal1,
    );
    gaiaChain = new cosmosWrapper.CosmosWrapper(
      testState.sdk2,
      testState.blockWaiter2,
      COSMOS_DENOM,
    );
    gaiaAccount = new cosmosWrapper.WalletWrapper(
      gaiaChain,
      testState.wallets.qaCosmos.genQaWal1,
    );
    gaiaAccount2 = new cosmosWrapper.WalletWrapper(
      gaiaChain,
      testState.wallets.qaCosmosTwo.genQaWal1,
    );
  });

  describe('Wallets', () => {
    test('Addresses', () => {
      expect(testState.wallets.neutron.demo1.address.toString()).toEqual(
        'neutron1m9l358xunhhwds0568za49mzhvuxx9ux8xafx2',
      );
      expect(testState.wallets.cosmos.demo2.address.toString()).toEqual(
        'cosmos10h9stc5v6ntgeygf5xf945njqq5h32r53uquvw',
      );
    });
  });

  describe('Contracts', () => {
    let codeId: types.CodeId;
    test('store contract', async () => {
      codeId = await neutronAccount.storeWasm(
        types.NeutronContract.IBC_TRANSFER,
      );
      expect(codeId).toBeGreaterThan(0);
    });
    test('instantiate', async () => {
      const res = await neutronAccount.instantiateContract(
        codeId,
        '{}',
        'ibc_transfer',
      );
      contractAddress = res[0]._contract_address;
    });
  });

  describe('IBC', () => {
    describe('Correct way', () => {
      let relayerBalance = 0;
      beforeAll(async () => {
        await neutronChain.blockWaiter.waitBlocks(10);
        const balances = await neutronChain.queryBalances(
          IBC_RELAYER_NEUTRON_ADDRESS,
        );
        relayerBalance = parseInt(
          balances.balances.find((bal) => bal.denom == NEUTRON_DENOM)?.amount ||
            '0',
          10,
        );
      });
      test('transfer to contract', async () => {
        const res = await neutronAccount.msgSend(
          contractAddress.toString(),
          '50000',
        );
        expect(res.code).toEqual(0);
      });
      test('check balance', async () => {
        const balances = await neutronChain.queryBalances(contractAddress);
        expect(balances.balances).toEqual([
          { amount: '50000', denom: NEUTRON_DENOM },
        ]);
      });
      test('IBC transfer from a usual account', async () => {
        const res = await neutronAccount.msgIBCTransfer(
          'transfer',
          'channel-0',
          { denom: NEUTRON_DENOM, amount: '1000' },
          gaiaAccount.wallet.address.toString(),
          {
            revision_number: new Long(2),
            revision_height: new Long(100000000),
          },
        );
        expect(res.code).toEqual(0);
      });
      test('check IBC token balance', async () => {
        await neutronChain.blockWaiter.waitBlocks(10);
        const balances = await gaiaChain.queryBalances(
          gaiaAccount.wallet.address.toString(),
        );
        expect(
          balances.balances.find(
            (bal): boolean =>
              bal.denom ==
              'ibc/4E41ED8F3DCAEA15F4D6ADC6EDD7C04A676160735C9710B904B7BF53525B56D6',
          )?.amount,
        ).toEqual('1000');
      });
      test('uatom IBC transfer from a remote chain to Neutron', async () => {
        const res = await gaiaAccount.msgIBCTransfer(
          'transfer',
          'channel-0',
          { denom: COSMOS_DENOM, amount: '1000' },
          neutronAccount.wallet.address.toString(),
          {
            revision_number: new Long(2),
            revision_height: new Long(100000000),
          },
        );
        expect(res.code).toEqual(0);
      });
      test('check uatom token balance transfered  via IBC on Neutron', async () => {
        await neutronChain.blockWaiter.waitBlocks(10);
        const balances = await neutronChain.queryBalances(
          neutronAccount.wallet.address.toString(),
        );
        expect(
          balances.balances.find(
            (bal): boolean =>
              bal.denom ==
              'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
          )?.amount,
        ).toEqual('1000');
      });
      test('check that weird IBC denom is uatom indeed', async () => {
        const denomTrace = await neutronChain.queryDenomTrace(
          '27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
        );
        expect(denomTrace.base_denom).toEqual(COSMOS_DENOM);
      });
      test('set payer fees', async () => {
        const res = await neutronAccount.executeContract(
          contractAddress,
          JSON.stringify({
            set_fees: {
              denom: neutronChain.denom,
              ack_fee: '2333',
              recv_fee: '0',
              timeout_fee: '2666',
            },
          }),
        );
        expect(res.code).toEqual(0);
      });

      test('execute contract', async () => {
        const res = await neutronAccount.executeContract(
          contractAddress,
          JSON.stringify({
            send: {
              channel: 'channel-0',
              to: gaiaAccount.wallet.address.toString(),
              denom: NEUTRON_DENOM,
              amount: '1000',
            },
          }),
        );
        expect(res.code).toEqual(0);
      });

      test('check wallet balance', async () => {
        await neutronChain.blockWaiter.waitBlocks(10);
        const balances = await gaiaChain.queryBalances(
          gaiaAccount.wallet.address.toString(),
        );
        // we expect X4 balance because the contract sends 2 txs: first one = amount and the second one amount*2 + transfer from a usual account
        expect(
          balances.balances.find(
            (bal): boolean =>
              bal.denom ==
              'ibc/4E41ED8F3DCAEA15F4D6ADC6EDD7C04A676160735C9710B904B7BF53525B56D6',
          )?.amount,
        ).toEqual('4000');
      });
      test('relayer must receive fee', async () => {
        await neutronChain.blockWaiter.waitBlocks(10);
        const balances = await neutronChain.queryBalances(
          IBC_RELAYER_NEUTRON_ADDRESS,
        );
        const balance = parseInt(
          balances.balances.find((bal) => bal.denom == NEUTRON_DENOM)?.amount ||
            '0',
          10,
        );
        expect(balance - 2333 * 2 - relayerBalance).toBeLessThan(5); // it may differ by about 1-2 because of the gas fee
      });
      test('contract should be refunded', async () => {
        await neutronChain.blockWaiter.waitBlocks(10);
        const balances = await neutronChain.queryBalances(contractAddress);
        const balance = parseInt(
          balances.balances.find((bal) => bal.denom == NEUTRON_DENOM)?.amount ||
            '0',
          10,
        );
        expect(balance).toBe(50000 - 3000 - 2333 * 2);
      });
    });
    describe('Missing fee', () => {
      beforeAll(async () => {
        await neutronAccount.executeContract(
          contractAddress,
          JSON.stringify({
            set_fees: {
              denom: neutronChain.denom,
              ack_fee: '0',
              recv_fee: '0',
              timeout_fee: '0',
            },
          }),
        );
      });
      test('execute contract should fail', async () => {
        await expect(
          neutronAccount.executeContract(
            contractAddress,
            JSON.stringify({
              send: {
                channel: 'channel-0',
                to: gaiaAccount.wallet.address.toString(),
                denom: NEUTRON_DENOM,
                amount: '1000',
              },
            }),
          ),
        ).rejects.toThrow(/invalid coins/);
      });
    });
    describe('Multihops', () => {
      // 1. Check balance of Account 1 on Chain 1
      // 2. Check balance of Account 3 on Chain 2
      // 3. Check balance of Account 2 on Chain 1
      // 4. Account 1 on Chain 1 sends x tokens to Account 2 on Chain 1 via Account 3 on Chain 2
      // 5. Check Balance of Account 3 on Chain 2, confirm it stays the same
      // 6. Check Balance of Account 1 on Chain 1, confirm it is original minus x tokens
      // 7. Check Balance of Account 2 on Chain 1, confirm it is original plus x tokens
      test('IBC transfer from a usual account', async () => {
        const sender = gaiaAccount.wallet.address.toString();
        const middlehop = neutronAccount.wallet.address.toString();
        const receiver = gaiaAccount2.wallet.address.toString();
        const senderNTRNBalanceBefore = await gaiaChain.queryDenomBalance(
          sender,
          COSMOS_DENOM,
        );

        const receiverNTRNBalanceBefore = await gaiaChain.queryDenomBalance(
          receiver,
          COSMOS_DENOM,
        );

        const transferAmount = 333333;

        const res = await gaiaAccount.msgIBCTransfer(
          'transfer',
          'channel-0',
          { denom: COSMOS_DENOM, amount: transferAmount + '' },
          middlehop,
          {
            revision_number: new Long(2),
            revision_height: new Long(100000000),
          },
          `{"forward": {"receiver": "${receiver}", "port": "transfer", "channel": "channel-0"}}`,
        );
        expect(res.code).toEqual(0);

        await neutronChain.blockWaiter.waitBlocks(20);

        const middlehopNTRNBalanceAfter = await neutronChain.queryDenomBalance(
          middlehop,
          'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
        );
        expect(middlehopNTRNBalanceAfter).toEqual(1000);

        const senderNTRNBalanceAfter = await gaiaChain.queryDenomBalance(
          sender,
          COSMOS_DENOM,
        );
        expect(senderNTRNBalanceAfter).toEqual(
          senderNTRNBalanceBefore - transferAmount - 1000, // original balance - transfer amount - fee
        );

        const receiverNTRNBalanceAfter = await gaiaChain.queryDenomBalance(
          receiver,
          COSMOS_DENOM,
        );
        expect(receiverNTRNBalanceAfter).toEqual(
          receiverNTRNBalanceBefore + transferAmount,
        );
      });
    });
  });
});
