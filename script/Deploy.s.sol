// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {BankrRenewerDistributor} from "../src/BankrRenewerDistributor.sol";
import {BankrFeeRouter} from "../src/BankrFeeRouter.sol";

/// forge script script/Deploy.s.sol:Deploy --rpc-url $BASE_RPC_URL --broadcast --private-key $DEPLOYER_KEY
contract Deploy is Script {
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address internal constant DEFAULT_BNKR = 0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b;
    address internal constant DEFAULT_OPS = 0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4;

    function run() external {
        address owner = vm.envAddress("PAYOUT_OWNER");
        address keeper = vm.envAddress("PAYOUT_KEEPER");
        address opsRecipient = vm.envOr("OPS_RECIPIENT", vm.envOr("WETH_RECIPIENT", DEFAULT_OPS));
        address pairedToken = vm.envOr("PAIRED_TOKEN", DEFAULT_BNKR);
        address projectToken = vm.envOr("PROJECT_TOKEN", address(0));

        vm.startBroadcast();
        BankrRenewerDistributor distributor = new BankrRenewerDistributor(owner, keeper);
        BankrFeeRouter router =
            new BankrFeeRouter(BASE_WETH, pairedToken, opsRecipient, projectToken, address(distributor));
        vm.stopBroadcast();

        console.log("CHAIN_ID", block.chainid);
        console.log("BANKR_RENEWER_DISTRIBUTOR", address(distributor));
        console.log("BANKR_FEE_ROUTER", address(router));
        console.log("OPS_RECIPIENT", opsRecipient);
        console.log("PAIRED_TOKEN", pairedToken);
        console.log("PROJECT_TOKEN", projectToken);
    }
}
