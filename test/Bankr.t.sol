// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BankrRenewerDistributor} from "../src/BankrRenewerDistributor.sol";
import {BankrFeeRouter} from "../src/BankrFeeRouter.sol";

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract BankrTest is Test {
    address internal constant OPS = 0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4;

    BankrRenewerDistributor internal distributor;
    BankrFeeRouter internal router;
    MockERC20 internal weth;
    MockERC20 internal paired;
    MockERC20 internal token;
    address internal keeper = address(0xBEEF);
    address internal renewer = address(0xCAFE);

    function setUp() public {
        weth = new MockERC20();
        paired = new MockERC20();
        token = new MockERC20();
        distributor = new BankrRenewerDistributor(OPS, keeper);
        router = new BankrFeeRouter(address(weth), address(paired), OPS, address(token), address(distributor));
    }

    function test_router_splits_paired_and_project_token() public {
        paired.mint(address(router), 5 ether);
        token.mint(address(router), 100 ether);
        router.route();
        assertEq(paired.balanceOf(OPS), 5 ether);
        assertEq(token.balanceOf(address(distributor)), 100 ether);
    }

    function test_routeToken_sends_paired_to_ops() public {
        paired.mint(address(router), 2 ether);
        router.routeToken(address(paired));
        assertEq(paired.balanceOf(OPS), 2 ether);
    }

    function test_absorb_and_payBatch() public {
        token.mint(address(distributor), 100 ether);
        vm.prank(keeper);
        uint256 roundId = distributor.openRound(address(token));
        vm.prank(keeper);
        distributor.absorbBalance(roundId);

        bytes32 leaf = keccak256(abi.encodePacked(renewer, uint256(100 ether)));
        vm.prank(keeper);
        distributor.lockRound(roundId, leaf, 1);

        address[] memory recipients = new address[](1);
        recipients[0] = renewer;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100 ether;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        distributor.payBatch(roundId, recipients, amounts, proofs);
        assertEq(token.balanceOf(renewer), 100 ether);
    }
}
