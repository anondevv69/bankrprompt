// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {BankrFeeRouter} from "../src/BankrFeeRouter.sol";

/// Deploy router v2 only, reusing an existing distributor.
/// forge script script/DeployRouter.s.sol:DeployRouter --rpc-url $BASE_RPC_URL --broadcast --private-key $DEPLOYER_KEY
contract DeployRouter is Script {
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address internal constant DEFAULT_BNKR = 0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b;
    address internal constant DEFAULT_OPS = 0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4;
    address internal constant LIVE_DISTRIBUTOR = 0x2a3D662ec48498C85FdfdE2C61C88EE19f77BA3B;

    function run() external {
        address opsRecipient = vm.envOr("OPS_RECIPIENT", vm.envOr("WETH_RECIPIENT", DEFAULT_OPS));
        address pairedToken = vm.envOr("PAIRED_TOKEN", DEFAULT_BNKR);
        address projectToken = vm.envOr("PROJECT_TOKEN", address(0));
        address distributor = vm.envOr("BANKR_RENEWER_DISTRIBUTOR", LIVE_DISTRIBUTOR);

        vm.startBroadcast();
        BankrFeeRouter router =
            new BankrFeeRouter(BASE_WETH, pairedToken, opsRecipient, projectToken, distributor);
        vm.stopBroadcast();

        console.log("CHAIN_ID", block.chainid);
        console.log("BANKR_FEE_ROUTER", address(router));
        console.log("BANKR_RENEWER_DISTRIBUTOR", distributor);
        console.log("OPS_RECIPIENT", opsRecipient);
        console.log("PAIRED_TOKEN", pairedToken);
        console.log("PROJECT_TOKEN", projectToken);
    }
}
