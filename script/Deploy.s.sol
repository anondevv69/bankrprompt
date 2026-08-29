// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {BankrRenewerDistributor} from "../src/BankrRenewerDistributor.sol";
import {BankrFeeRouter} from "../src/BankrFeeRouter.sol";

/// forge script script/Deploy.s.sol:Deploy --rpc-url $BASE_RPC_URL --broadcast --private-key $DEPLOYER_KEY
contract Deploy is Script {
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address internal constant DEFAULT_WETH_RECIPIENT = 0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4;

    function run() external {
        address owner = vm.envAddress("PAYOUT_OWNER");
        address keeper = vm.envAddress("PAYOUT_KEEPER");
        address wethRecipient = vm.envOr("WETH_RECIPIENT", DEFAULT_WETH_RECIPIENT);
        address projectToken = vm.envOr("PROJECT_TOKEN", address(0));

        vm.startBroadcast();
        BankrRenewerDistributor distributor = new BankrRenewerDistributor(owner, keeper);
        BankrFeeRouter router = new BankrFeeRouter(BASE_WETH, wethRecipient, projectToken, address(distributor));
        vm.stopBroadcast();

        console.log("CHAIN_ID", block.chainid);
        console.log("BANKR_RENEWER_DISTRIBUTOR", address(distributor));
        console.log("BANKR_FEE_ROUTER", address(router));
        console.log("WETH_RECIPIENT", wethRecipient);
        console.log("PROJECT_TOKEN", projectToken);
    }
}
