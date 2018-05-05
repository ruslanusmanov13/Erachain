package core.transaction;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;

import org.json.simple.JSONObject;
import org.mapdb.Fun.Tuple2;
import org.mapdb.Fun.Tuple3;
import org.mapdb.Fun.Tuple5;

import com.google.common.primitives.Bytes;
import com.google.common.primitives.Longs;

import core.account.Account;
import core.account.PublicKeyAccount;
import core.block.Block;
import core.crypto.Base58;
import core.crypto.Crypto;
import datachain.DCSet;

public class CancelOrderTransaction extends Transaction
{
	// TODO - reference to ORDER - by recNor INT+INT - not 64xBYTE[] !!!
	private static final byte TYPE_ID = (byte)CANCEL_ORDER_TRANSACTION;
	private static final String NAME_ID = "Cancel Order";
	private static final int ORDER_LENGTH = Crypto.SIGNATURE_LENGTH;
	private static final int BASE_LENGTH = Transaction.BASE_LENGTH + ORDER_LENGTH;

	private BigInteger orderID;
	public static final byte[][] VALID_REC = new byte[][]{
	};


	public CancelOrderTransaction(byte[] typeBytes, PublicKeyAccount creator, BigInteger order, byte feePow, long timestamp, Long reference) {
		super(typeBytes, NAME_ID, creator, feePow, timestamp, reference);
		this.orderID = order;
	}
	public CancelOrderTransaction(byte[] typeBytes, PublicKeyAccount creator, BigInteger order, byte feePow, long timestamp, Long reference, byte[] signature) {
		this(typeBytes, creator, order, feePow, timestamp, reference);
		this.signature = signature;
		//this.calcFee();
	}
	public CancelOrderTransaction(PublicKeyAccount creator, BigInteger order, byte feePow, long timestamp, Long reference, byte[] signature) {
		this(new byte[]{TYPE_ID, 0, 0, 0}, creator, order, feePow, timestamp, reference, signature);
	}
	public CancelOrderTransaction(PublicKeyAccount creator, BigInteger order, byte feePow, long timestamp, Long reference) {
		this(new byte[]{TYPE_ID, 0, 0, 0}, creator, order, feePow, timestamp, reference);
	}

	//GETTERS/SETTERS
	//public static String getName() { return "OLD: Cancel Order"; }

	public BigInteger getOrder()
	{
		return this.orderID;
	}

	@Override
	public boolean hasPublicText() {
		return false;
	}

	//PARSE CONVERT

	public static Transaction Parse(byte[] data, Long releaserReference) throws Exception
	{
		boolean asPack = releaserReference != null;

		//CHECK IF WE MATCH BLOCK LENGTH
		if (data.length < BASE_LENGTH_AS_PACK
				| !asPack & data.length < BASE_LENGTH)
		{
			throw new Exception("Data does not match block length " + data.length);
		}

		// READ TYPE
		byte[] typeBytes = Arrays.copyOfRange(data, 0, TYPE_LENGTH);
		int position = TYPE_LENGTH;

		long timestamp = 0;
		if (!asPack) {
			//READ TIMESTAMP
			byte[] timestampBytes = Arrays.copyOfRange(data, position, position + TIMESTAMP_LENGTH);
			timestamp = Longs.fromByteArray(timestampBytes);
			position += TIMESTAMP_LENGTH;
		}

		Long reference = null;
		if (!asPack) {
			//READ REFERENCE
			byte[] referenceBytes = Arrays.copyOfRange(data, position, position + REFERENCE_LENGTH);
			reference = Longs.fromByteArray(referenceBytes);
			position += REFERENCE_LENGTH;
		} else {
			reference = releaserReference;
		}

		//READ CREATOR
		byte[] creatorBytes = Arrays.copyOfRange(data, position, position + CREATOR_LENGTH);
		PublicKeyAccount creator = new PublicKeyAccount(creatorBytes);
		position += CREATOR_LENGTH;

		byte feePow = 0;
		if (!asPack) {
			//READ FEE POWER
			byte[] feePowBytes = Arrays.copyOfRange(data, position, position + 1);
			feePow = feePowBytes[0];
			position += 1;
		}

		//READ SIGNATURE
		byte[] signatureBytes = Arrays.copyOfRange(data, position, position + SIGNATURE_LENGTH);
		position += SIGNATURE_LENGTH;

		//READ ORDER
		byte[] orderBytes = Arrays.copyOfRange(data, position, position + ORDER_LENGTH);
		BigInteger order = new BigInteger(orderBytes);
		position += ORDER_LENGTH;

		return new CancelOrderTransaction(typeBytes, creator, order, feePow, timestamp, reference, signatureBytes);
	}

	@SuppressWarnings("unchecked")
	@Override
	public JSONObject toJson()
	{
		//GET BASE
		JSONObject transaction = this.getJsonBase();

		//ADD CREATOR/ORDER
		transaction.put("creator", this.creator.getAddress());
		transaction.put("orderID", Base58.encode(this.orderID.toByteArray()));

		return transaction;
	}

	//@Override
	@Override
	public byte[] toBytes(boolean withSign, Long releaserReference)
	{
		byte[] data = super.toBytes(withSign, releaserReference);

		//WRITE ORDER
		byte[] orderBytes = this.orderID.toByteArray();
		byte[] fill = new byte[ORDER_LENGTH - orderBytes.length];
		orderBytes = Bytes.concat(fill, orderBytes);
		data = Bytes.concat(data, orderBytes);

		return data;
	}

	@Override
	public int getDataLength(boolean asPack)
	{
		return BASE_LENGTH;
	}

	//VALIDATE

	//@Override
	@Override
	public int isValid(Long releaserReference, long flags)
	{

		for ( byte[] valid_item: VALID_REC) {
			if (Arrays.equals(this.signature, valid_item)) {
				return VALIDATE_OK;
			}
		}

		//CHECK IF ORDER EXISTS
		Tuple3<Tuple5<BigInteger, String, Long, Boolean, BigDecimal>,
		Tuple3<Long, BigDecimal, BigDecimal>, Tuple2<Long, BigDecimal>> order = null;
		if(this.dcSet.getOrderMap().contains(this.orderID))
			order = this.dcSet.getOrderMap().get(this.orderID);

		if (order== null)
			return ORDER_DOES_NOT_EXIST;

		///
		//CHECK IF CREATOR IS CREATOR
		if(!order.a.b.equals(this.creator.getAddress()))
		{
			return INVALID_ORDER_CREATOR;
		}

		return super.isValid(releaserReference, flags);
	}

	//PROCESS/ORPHAN

	public static void process_it(DCSet db, Tuple3<Tuple5<BigInteger, String, Long, Boolean, BigDecimal>,
			Tuple3<Long, BigDecimal, BigDecimal>, Tuple2<Long, BigDecimal>> order)
	{
		if (false & !db.isFork() &&
				(order.b.a == 1027l && order.c.a == 2l
				|| order.c.a == 2l && order.c.a == 1027l)) {
			int ii = 123;
			ii++;
		}
		//SET ORPHAN DATA
		db.getCompletedOrderMap().add(order);

		//UPDATE BALANCE OF CREATOR
		Account creator = new Account(order.a.b);
		//creator.setBalance(orderID.getHave(), creator.getBalance(db, orderID.getHave()).add(orderID.getAmountHaveLeft()), db);
		creator.changeBalance(db, false, order.b.a, order.b.b.subtract(order.b.c), false);

		//DELETE FROM DATABASE
		db.getOrderMap().delete(order.a.a);
	}

	//@Override
	@Override
	public void process(Block block, boolean asPack)
	{
		//UPDATE CREATOR
		super.process(block, asPack);

		Tuple3<Tuple5<BigInteger, String, Long, Boolean, BigDecimal>,
		Tuple3<Long, BigDecimal, BigDecimal>, Tuple2<Long, BigDecimal>> order = this.dcSet.getOrderMap().get(this.orderID);
		process_it(this.dcSet, order);
	}

	public static void orphan_it(DCSet db, Tuple3<Tuple5<BigInteger, String, Long, Boolean, BigDecimal>,
			Tuple3<Long, BigDecimal, BigDecimal>, Tuple2<Long, BigDecimal>> order)
	{
		db.getOrderMap().add(order);

		//REMOVE BALANCE OF CREATOR
		Account creator = new Account(order.a.b);
		//creator.setBalance(orderID.getHave(), creator.getBalance(db, orderID.getHave()).subtract(orderID.getAmountHaveLeft()), db);
		creator.changeBalance(db, true, order.b.a, order.b.b.subtract(order.b.c), true);

		//DELETE ORPHAN DATA
		db.getCompletedOrderMap().delete(order.a.a);
	}
	//@Override
	@Override
	public void orphan(boolean asPack)
	{
		//UPDATE CREATOR
		super.orphan(asPack);

		//ADD TO DATABASE
		Tuple3<Tuple5<BigInteger, String, Long, Boolean, BigDecimal>,
		Tuple3<Long, BigDecimal, BigDecimal>, Tuple2<Long, BigDecimal>> order = this.dcSet.getCompletedOrderMap().get(this.orderID);
		orphan_it(this.dcSet, order);
	}

	@Override
	public HashSet<Account> getInvolvedAccounts()
	{
		HashSet<Account> accounts = new HashSet<>();
		accounts.add(this.creator);
		return accounts;
	}

	@Override
	public HashSet<Account> getRecipientAccounts()
	{
		return new HashSet<>();
	}

	@Override
	public boolean isInvolved(Account account)
	{
		String address = account.getAddress();

		if(address.equals(this.creator.getAddress()))
		{
			return true;
		}

		return false;
	}

	/*
	@Override
	public BigDecimal Amount(Account account)
	{
		String address = account.getAddress();

		if(address.equals(this.creator.getAddress()))
		{
			return BigDecimal.ZERO.setScale(BlockChain.AMOUNT_DEDAULT_SCALE);
		}

		return BigDecimal.ZERO;
	}
	 */

	//@Override
	public Map<String, Map<Long, BigDecimal>> getAssetAmount()
	{
		Map<String, Map<Long, BigDecimal>> assetAmount = new LinkedHashMap<>();

		assetAmount = subAssetAmount(assetAmount, this.creator.getAddress(), FEE_KEY, this.fee);

		Tuple3<Tuple5<BigInteger, String, Long, Boolean, BigDecimal>,
		Tuple3<Long, BigDecimal, BigDecimal>, Tuple2<Long, BigDecimal>> order;

		if(this.dcSet.getCompletedOrderMap().contains(this.orderID))
		{
			order =  this.dcSet.getCompletedOrderMap().get(this.orderID);
		}
		else
		{
			order =  this.dcSet.getOrderMap().get(this.orderID);
		}

		assetAmount = addAssetAmount(assetAmount, this.creator.getAddress(), order.b.a, order.b.c);

		return assetAmount;
	}
	@Override
	public int calcBaseFee() {
		return 2 * calcCommonFee();
	}
}
