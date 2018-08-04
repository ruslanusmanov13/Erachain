package core.item.assets;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import com.google.common.primitives.Bytes;
import com.google.common.primitives.Longs;
import datachain.*;
import org.json.simple.JSONObject;
import org.mapdb.Fun.Tuple2;
import org.mapdb.Fun.Tuple3;
import org.mapdb.Fun.Tuple5;

import core.BlockChain;
import core.account.Account;
import core.crypto.Base58;
import core.crypto.Crypto;
import core.transaction.CancelOrderTransaction;
import core.transaction.Transaction;

public class Order implements Comparable<Order> {

    private static final MathContext rounding = new java.math.MathContext(12, RoundingMode.HALF_DOWN);

    final private static BigDecimal precisionUnit = BigDecimal.ONE.scaleByPowerOfTen(-BlockChain.TRADE_PRECISION + 1);

    public static final int ID_LENGTH = 8; //Crypto.SIGNATURE_LENGTH;
    private static final int CREATOR_LENGTH = 20; // as SHORT (old - 25)
    private static final int HAVE_LENGTH = 8;
    private static final int WANT_LENGTH = 8;
    private static final int SCALE_LENGTH = 1;
    private static final int AMOUNT_LENGTH = 8;
    public static final int FULFILLED_LENGTH = AMOUNT_LENGTH + 4;
    private static final int TIMESTAMP_LENGTH = 8;
    //private static final int EXECUTABLE_LENGTH = 1;
    private static final int BASE_LENGTH = ID_LENGTH + CREATOR_LENGTH + HAVE_LENGTH + WANT_LENGTH
            + 2 * SCALE_LENGTH + 2 * AMOUNT_LENGTH + SCALE_LENGTH + FULFILLED_LENGTH + TIMESTAMP_LENGTH;

    protected DCSet dcSet;
    protected long timestamp;
    private Long id;
    private Account creator;
    private long haveKey;
    private long wantKey;
    private BigDecimal amountHave;
    private BigDecimal fulfilledHave;
    private BigDecimal amountWant;
    private BigDecimal price;

    public Order(Long id, Account creator, long haveKey, long wantKey, BigDecimal amountHave, BigDecimal amountWant, long timestamp) {
        this.id = id;
        this.creator = creator;
        this.haveKey = haveKey;
        this.wantKey = wantKey;

        this.amountHave = amountHave;
        this.amountWant = amountWant;

        this.fulfilledHave = BigDecimal.ZERO.setScale(amountHave.scale());

        this.price = calcPrice(amountHave, amountWant);

        this.timestamp = timestamp;
    }

    public Order(Long id, Account creator, long haveKey, long wantKey, BigDecimal amountHave,
                 BigDecimal amountWant, BigDecimal fulfilledHave,
                 long timestamp) {
        this.id = id;
        this.creator = creator;
        this.haveKey = haveKey;
        this.wantKey = wantKey;

        this.amountHave = amountHave;
        this.amountWant = amountWant;

        this.fulfilledHave = fulfilledHave;

        this.price = calcPrice(amountHave, amountWant);

        this.timestamp = timestamp;
    }

    //GETTERS/SETTERS

    public static Order getOrder(DCSet db, Long key) {
        if (db.getOrderMap().contains(key)) {
            return db.getOrderMap().get(key);
        }

        if (db.getCompletedOrderMap().contains(key)) {
            return db.getCompletedOrderMap().get(key);
        }

        return null;

    }

    public static int powerTen(BigDecimal value) {
        BigDecimal t = value;
        int i = 0;
        while (t.compareTo(BigDecimal.ONE) > 0) {
            t = t.movePointLeft(1);
            i++;
        }
        return i;
    }

    // BigDecimal.precision() - is WRONG calculating!!! Sometime = 0 for 100 or 10
    public static int precision(BigDecimal value) {
        return powerTen(value) + value.scale();
    }

    public static BigDecimal calcPrice(BigDecimal amountHave, BigDecimal amountWant) {
        int scalePrice = amountWant.scale();
        // .precision() - WRONG calculating!!!! scalePrice = amountHave.setScale(0, RoundingMode.UP).precision() + scalePrice>0?scalePrice : 0;
        scalePrice = Order.powerTen(amountHave) + (scalePrice > 0 ? scalePrice : 0);
        BigDecimal result = amountWant.divide(amountHave, scalePrice, RoundingMode.HALF_DOWN).stripTrailingZeros();

        // IF SCALE = -1..1 - make error in mapDB - org.mapdb.DataOutput2.packInt(DataOutput, int)
        if (result.scale() < 0)
            return result.setScale(0);
        return result;
    }

    public static BigDecimal calcAmountWantLeft(Tuple3<Tuple5<Long, String, Long, Boolean, BigDecimal>,
            Tuple3<Long, BigDecimal, BigDecimal>, Tuple2<Long, BigDecimal>> order) {
        return order.b.b.subtract(order.b.c).multiply(order.a.e).setScale(order.c.b.scale(), RoundingMode.HALF_DOWN).stripTrailingZeros();
    }

    /*
    public static boolean isGoodIncrement(Tuple3<Tuple5<Long, String, Long, Boolean, BigDecimal>,
            Tuple3<Long, BigDecimal, BigDecimal>, Tuple2<Long, BigDecimal>> order,
                                          Tuple3<Tuple5<Long, String, Long, Boolean, BigDecimal>,
                                                  Tuple3<Long, BigDecimal, BigDecimal>, Tuple2<Long, BigDecimal>> target) {
        // return order.b.c.compareTo(target.a.e.scaleByPowerOfTen(-order.c.b.scale())) < 0;
        return true;
    }
    */

    public static Order reloadOrder(DCSet dcSet, Long orderID) {

        return dcSet.getCompletedOrderMap().contains(orderID) ?
                dcSet.getCompletedOrderMap().get(orderID) :
                dcSet.getOrderMap().get(orderID);

    }

    /*
    public static Order toDBrec(Order order) {
        return new Tuple3<Tuple5<Long, String, Long, Boolean, BigDecimal>,
                Tuple3<Long, BigDecimal, BigDecimal>, Tuple2<Long, BigDecimal>>(
                new Tuple5<Long, String, Long, Boolean, BigDecimal>(order.getId(), order.getCreator().getAddress(), order.getTimestamp(), order.isExecutable(), order.getPrice()),
                new Tuple3<Long, BigDecimal, BigDecimal>(order.getHave(), order.getAmountHave(), order.getFulfilledHave()),
                new Tuple2<Long, BigDecimal>(order.getWant(), order.getAmountWant()));

    }

    public static Order fromDBrec(Tuple3<Tuple5<Long, String, Long, Boolean, BigDecimal>,
            Tuple3<Long, BigDecimal, BigDecimal>, Tuple2<Long, BigDecimal>> order) {
        return new Order(order.a.a, new Account(order.a.b), order.b.a, order.c.a, order.b.b,
                order.c.b, order.b.c,
                (byte) (order.a.d ? 1 : 0), order.a.c);

    }
    */

    public void setDC(DCSet dcSet) {
        this.dcSet = dcSet;
    }

    public Long getId() {
        return this.id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Account getCreator() {
        return this.creator;
    }

    public long getHave() {
        return this.haveKey;
    }

    public AssetCls getHaveAsset() {
        return this.getHaveAsset(this.dcSet);
    }

    public AssetCls getHaveAsset(DCSet db) {
        return (AssetCls) db.getItemAssetMap().get(this.haveKey);
    }

    public long getWant() {
        return this.wantKey;
    }

    public AssetCls getWantAsset() {
        return this.getWantAsset(this.dcSet);
    }

    public AssetCls getWantAsset(DCSet db) {
        return db.getItemAssetMap().get(this.wantKey);
    }

    ///////////////////////// AMOUNTS
    public BigDecimal getAmountHave() {
        return this.amountHave;
    }

    public BigDecimal getAmountWant() {
        return this.amountWant;
    }

    public BigDecimal getAmountHaveLeft() {
        return this.amountHave.subtract(this.fulfilledHave);
    }

    public BigDecimal getAmountWantLeft() {
        return this.getAmountHaveLeft().multiply(this.price, rounding).setScale(this.amountWant.scale(), RoundingMode.HALF_DOWN);
    }

    //////// FULFILLED
    public BigDecimal getFulfilledHave() {
        return this.fulfilledHave;
    }

    public void setFulfilledHave(BigDecimal fulfilled) {
        this.fulfilledHave = fulfilled;
    }

    public boolean isFulfilled() {
        return this.fulfilledHave.compareTo(this.amountHave) == 0;
    }

    public BigDecimal getFulfilledWant() {
        return this.fulfilledHave.multiply(this.price).setScale(this.amountWant.scale(), RoundingMode.HALF_DOWN);
    }

    ///////// PRICE
    public BigDecimal getPrice() {
        return this.price;
    }

    public String viewPrice() {
        return getPrice().toPlainString();
    }

    public long getTimestamp() {
        return this.timestamp;
    }

    public List<Trade> getInitiatedTrades() {
        return this.getInitiatedTrades(DCSet.getInstance());
    }

    public List<Trade> getInitiatedTrades(DCSet db) {
        return db.getTradeMap().getInitiatedTrades(this);
    }

    //PARSE/CONVERT

	// forDB - use fulFill
	public static Order parse(byte[] data) throws Exception
	{
		//CHECK IF CORRECT LENGTH
		if(data.length != BASE_LENGTH)
		{
			throw new Exception("Data does not match order length");
		}

		int position = 0;

		// TODO - ID not need as reference in ASSETS ?? no!

		//READ ID
		byte[] idBytes = Arrays.copyOfRange(data, position, position + ID_LENGTH);
        long id = Longs.fromByteArray(idBytes);
		position += ID_LENGTH;

		//READ CREATOR
		byte[] creatorBytes = Arrays.copyOfRange(data, position, position + CREATOR_LENGTH);
		Account creator = Account.makeAccountFromShort(creatorBytes);
		position += CREATOR_LENGTH;

		//READ HAVE
		byte[] haveBytes = Arrays.copyOfRange(data, position, position + HAVE_LENGTH);
		long have = Longs.fromByteArray(haveBytes);
		position += HAVE_LENGTH;

        //READ HAVE
		byte[] wantBytes = Arrays.copyOfRange(data, position, position + WANT_LENGTH);
		long want = Longs.fromByteArray(wantBytes);
		position += WANT_LENGTH;

        //READ HAVE SCALE
        byte scaleHave = Arrays.copyOfRange(data, position, position + 1)[0];
        position ++;

        //READ AMOUNT HAVE
		byte[] amountHaveBytes = Arrays.copyOfRange(data, position, position + AMOUNT_LENGTH);
		BigDecimal amountHave = new BigDecimal(new BigInteger(amountHaveBytes), scaleHave);
		position += AMOUNT_LENGTH;

        //READ HAVE SCALE
        byte scaleWant = Arrays.copyOfRange(data, position, position + 1)[0];
        position ++;

        //READ AMOUNT WANT
		byte[] amountWantBytes = Arrays.copyOfRange(data, position, position + AMOUNT_LENGTH);
		BigDecimal amountWant = new BigDecimal(new BigInteger(amountWantBytes), scaleWant);
		position += AMOUNT_LENGTH;

		//READ TIMESTAMP
		byte[] timestampBytes = Arrays.copyOfRange(data, position, position + TIMESTAMP_LENGTH);
		long timestamp = Longs.fromByteArray(timestampBytes);
		position += TIMESTAMP_LENGTH;

        //READ FULFILLED HAVE SCALE
        byte scalefulfilledHave = Arrays.copyOfRange(data, position, position + 1)[0];
        position ++;

        //READ FULFILLED HAVE
		byte[] fulfilledHaveBytes = Arrays.copyOfRange(data, position, position + FULFILLED_LENGTH);
		BigDecimal fulfilledHave = new BigDecimal(new BigInteger(fulfilledHaveBytes), scalefulfilledHave);
		position += FULFILLED_LENGTH;

		return new Order(id, creator, have, want, amountHave, amountWant, fulfilledHave, timestamp);

	}

	public byte[] toBytes()
	{
		byte[] data = new byte[0];

		//WRITE ID
		byte[] idBytes = Longs.toByteArray(this.id);
		byte[] fill = new byte[ID_LENGTH - idBytes.length];
		idBytes = Bytes.concat(fill, idBytes);
		data = Bytes.concat(data, idBytes);

		//WRITE CREATOR
		try
		{
			data = Bytes.concat(data , this.creator.getShortAddressBytes());
		}
		catch(Exception e)
		{
			//DECODE EXCEPTION
		}

		//WRITE HAVE
		byte[] haveBytes = Longs.toByteArray(this.haveKey);
        // only for BIGInteger and BigDecimal it need:
		//haveBytes = Bytes.ensureCapacity(haveBytes, HAVE_LENGTH, 0);
		data = Bytes.concat(data, haveBytes);

		//WRITE WANT
		byte[] wantBytes = Longs.toByteArray(this.wantKey);
		// only for BIGInteger and BigDecimal it need:
        // wantBytes = Bytes.ensureCapacity(wantBytes, WANT_LENGTH, 0);
		data = Bytes.concat(data, wantBytes);

        //WRITE AMOUNT HAVE SCALE
        data = Bytes.concat(data, new byte[]{(byte)this.amountHave.scale()});

        //WRITE AMOUNT HAVE
		byte[] amountHaveBytes = this.amountHave.unscaledValue().toByteArray();
		fill = new byte[AMOUNT_LENGTH - amountHaveBytes.length];
		amountHaveBytes = Bytes.concat(fill, amountHaveBytes);
		data = Bytes.concat(data, amountHaveBytes);

        //WRITE AMOUNT WANT SCALE
        data = Bytes.concat(data, new byte[]{(byte)this.amountWant.scale()});

        //WRITE AMOUNT WANT
		byte[] amountWantBytes = this.amountWant.unscaledValue().toByteArray();
		fill = new byte[AMOUNT_LENGTH - amountWantBytes.length];
		amountWantBytes = Bytes.concat(fill, amountWantBytes);
		data = Bytes.concat(data, amountWantBytes);

		//WRITE TIMESTAMP
		byte[] timestampBytes = Longs.toByteArray(this.timestamp);
		timestampBytes = Bytes.ensureCapacity(timestampBytes, TIMESTAMP_LENGTH, 0);
		data = Bytes.concat(data, timestampBytes);

		// TRY CUT SCALE
        byte[] fulfilledHaveBytes = this.fulfilledHave.unscaledValue().toByteArray();
        while (fulfilledHaveBytes.length > FULFILLED_LENGTH) {
            this.fulfilledHave.setScale(this.fulfilledHave.scale() - 1, BigDecimal.ROUND_HALF_UP);
            fulfilledHaveBytes = this.fulfilledHave.unscaledValue().toByteArray();
        }

        //WRITE AMOUNT HAVE SCALE
        data = Bytes.concat(data, new byte[]{(byte)this.fulfilledHave.scale()});

		//WRITE FULFILLED HAVE
		///fulfilledHaveBytes = this.fulfilledHave.unscaledValue().toByteArray();
		fill = new byte[FULFILLED_LENGTH - fulfilledHaveBytes.length];
		fulfilledHaveBytes = Bytes.concat(fill, fulfilledHaveBytes);
		data = Bytes.concat(data, fulfilledHaveBytes);

		return data;
	}

	public int getDataLength()
	{
		return BASE_LENGTH;
	}

    public boolean isConfirmed() {
        return isConfirmed(DCSet.getInstance());
    }

    public boolean isConfirmed(DCSet dc) {
        return dc.getOrderMap().contains(this.id)
                || dc.getCompletedOrderMap().contains(this.id);
    }

    @SuppressWarnings("unchecked")
    public JSONObject toJson() {

        JSONObject order = new JSONObject();
        order.put("haveKey", this.haveKey);
        order.put("wantKey", this.wantKey);
        order.put("amountHave", this.amountHave.toPlainString());
        order.put("amountWant", this.amountWant.toPlainString());
        order.put("fulfilledHave", this.fulfilledHave.toPlainString());
        order.put("price", this.price.toPlainString());

        return order;

    }

    //PROCESS/ORPHAN

    public void processTrade(Trade trade, Order target, BigDecimal tradeAmount, BigDecimal tradeAmountGet) {

    }

    public void process(Transaction transaction) {

        CompletedOrderMap completedMap = this.dcSet.getCompletedOrderMap();
        OrderMap ordersMap = this.dcSet.getOrderMap();
        TradeMap tradesMap = this.dcSet.getTradeMap();

        boolean debug = false;

        if (//this.creator.equals("78JFPWVVAVP3WW7S8HPgSkt24QF2vsGiS5") &&
                (this.haveKey == 1004l && this.wantKey == 2l)
                || (this.wantKey == 1004l && this.haveKey == 2l)
                //this.id.equals(new BigInteger(Base58.decode("4NxUYDifB8xuguu5gVkma4V1neseHXYXhFoougGDzq9m7VdZyn7hjWUYiN6M7vkj4R5uwnxauoxbrMaavRMThh7j")))
                //&& !db.isFork()
                ) {
            debug = true;
        }

        // NEED FOR making secondary keys in TradeMap
        ordersMap.add(this);

        //REMOVE HAVE
        //this.creator.setBalance(this.have, this.creator.getBalance(db, this.have).subtract(this.amountHave), db);
        this.creator.changeBalance(this.dcSet, true, this.haveKey, this.amountHave, true);

        //GET ALL ORDERS(WANT, HAVE) LOWEST PRICE FIRST
        //TRY AND COMPLETE ORDERS
        boolean completedOrder = false;
        int index = 0;
        BigDecimal thisPrice = this.price;
        //BigDecimal tempPrice;
        BigDecimal thisIncrement;
        //boolean isReversePrice = thisPrice.compareTo(BigDecimal.ONE) < 0;

        List<Order> orders = ordersMap.getOrdersForTradeWithFork(this.wantKey, this.haveKey, false);

        if (true && !orders.isEmpty()) {
            BigDecimal price = orders.get(0).getPrice();
            Long timestamp = orders.get(0).getTimestamp();
            for (Order item: orders) {
                if (item.getHave() != this.wantKey
                        || item.getWant() != this.haveKey) {
                    // RISE ERROR
                    timestamp = null;
                    ++timestamp;
                }
                // потому что сранивается потом обратная цена то тут должно быть возрастание
                // и если не так то ошибка
                int comp = price.compareTo(item.getPrice());
                if (comp > 0) {
                    // RISE ERROR
                    timestamp = null;
                    ++timestamp;
                } else if (comp == 0) {
                    // здесь так же должно быть возростание
                    // если не так то ошибка
                    if (timestamp.compareTo(item.getTimestamp()) > 0) {
                        // RISE ERROR
                        timestamp = null;
                        ++timestamp;
                    }
                }

                price = item.getPrice();
                timestamp = item.getTimestamp();
            }

        }

        BigDecimal thisAmountHaveLeft = this.getAmountHaveLeft();
        BigDecimal processedAmountFulfilledWant = BigDecimal.ZERO;

        int haveScale = this.getHaveAsset().getScale();
        int wantScale = this.getWantAsset().getScale();

        int compare = 0;

        if (debug) {
            debug = true;
        }

        while (!completedOrder && index < orders.size()) {
            //GET ORDER
            Order order;
            if (this.dcSet.isFork()) {
                // так как это все в памяти расположено то нужно создать новый объект
                // иначе везде будет ссылка на один и тот же объект и
                // при переходе на MAIN базу возьмется уже обновленный ордер из FORK DB
                order = orders.get(index++).copy();
            } else {
                order = orders.get(index++);
            }
            
            // for develop
            //String signB58 = Base58.encode(order.a.a);

            BigDecimal orderAmountHaveLeft;
            BigDecimal orderAmountWantLeft;
            BigDecimal orderReversePrice = Order.calcPrice(order.amountWant, order.amountHave);
            BigDecimal orderPrice = Order.calcPrice(order.amountHave, order.amountWant);
            //BigDecimal orderPriceTemp;

            Trade trade;
            BigDecimal tradeAmountHave;
            BigDecimal tradeAmountWant; // GET
            BigDecimal tradeAmountAccurate;
            BigDecimal differenceTrade;
            //BigDecimal differenceTradeThis;

            if (this.creator.equals(order.getCreator())) {
        	// IGNORE my self orders
        	continue;
            }
            
            ///////////////
            //CHECK IF BUYING PRICE IS HIGHER OR EQUAL THEN OUR SELLING PRICE
            if (thisPrice.compareTo(orderReversePrice) > 0)
                break;

            thisIncrement = orderPrice.scaleByPowerOfTen(-wantScale);
            if (thisAmountHaveLeft.compareTo(thisIncrement) < 0) {
                // if left not enough for 1 buy by price this order
                //error ++;
                completedOrder = true;
                // REVERT not completed AMOUNT
                this.getCreator().changeBalance(this.dcSet, false,
                        this.haveKey, this.getAmountHaveLeft(), false);
                break;
            }

            orderAmountHaveLeft = order.getAmountHaveLeft();
            orderAmountWantLeft = orderAmountHaveLeft.multiply(orderPrice).setScale(wantScale, RoundingMode.HALF_UP);

            compare = orderAmountWantLeft.compareTo(thisAmountHaveLeft);
            if (compare >= 0) {

                tradeAmountWant = thisAmountHaveLeft;
                if (compare == 0)
                    tradeAmountHave = orderAmountHaveLeft;
                else {

                    // RESOLVE amount with SCALE
                    tradeAmountAccurate = tradeAmountWant.multiply(orderReversePrice)
                            .setScale(haveScale + BlockChain.TRADE_PRECISION, RoundingMode.HALF_DOWN);
                    tradeAmountHave = tradeAmountAccurate.setScale(haveScale, RoundingMode.HALF_DOWN);

                    // PRECISON is WRONG!!! int tradeAmountPrecision = tradeAmount.precision();
                    int tradeAmountPrecision = Order.precision(tradeAmountHave);
                    if (tradeAmountPrecision < BlockChain.TRADE_PRECISION) {
                        // PRECISION soo SMALL
                        differenceTrade = tradeAmountHave.divide(tradeAmountAccurate, BlockChain.TRADE_PRECISION + 1, RoundingMode.HALF_DOWN);
                        differenceTrade = differenceTrade.subtract(BigDecimal.ONE).abs();
                        if (differenceTrade.compareTo(precisionUnit) > 0) {
                            // it is BAD ACCURACY
                            continue;
                        }
                    }
                }

                //THIS is COMPLETED
                completedOrder = true;

            } else {

                tradeAmountHave = orderAmountHaveLeft;
                tradeAmountWant = orderAmountWantLeft;

            }

            //CHECK IF AMOUNT AFTER ROUNDING IS NOT ZERO
            //AND WE CAN BUY ANYTHING
            if (tradeAmountHave.compareTo(BigDecimal.ZERO) > 0) {
                //CREATE TRADE

                // CUT PRECISION in bytes
                tradeAmountHave = tradeAmountHave.stripTrailingZeros();
                byte[] amountBytes = tradeAmountHave.unscaledValue().toByteArray();
                while (amountBytes.length > FULFILLED_LENGTH) {
                    tradeAmountHave.setScale(tradeAmountHave.scale() - 1, BigDecimal.ROUND_HALF_UP);
                    amountBytes = tradeAmountHave.unscaledValue().toByteArray();
                }
                tradeAmountWant = tradeAmountWant.stripTrailingZeros();
                amountBytes = tradeAmountWant.unscaledValue().toByteArray();
                while (amountBytes.length > FULFILLED_LENGTH) {
                    tradeAmountWant.setScale(tradeAmountWant.scale() - 1, BigDecimal.ROUND_HALF_UP);
                    amountBytes = tradeAmountWant.unscaledValue().toByteArray();
                }

                if (debug) {
                    debug = true;
                }

                //////////////////////////// TRADE /////////////////
                trade = new Trade(this.getId(), order.getId(), this.haveKey, this.wantKey,
                        tradeAmountHave, tradeAmountWant, transaction.getTimestamp());

                //ADD TRADE TO DATABASE
                tradesMap.add(trade);
                // TODO: delete it check
                if (!tradesMap.contains(new Tuple2<Long, Long>(this.getId(), order.getId()))) {
                    Long error = null;
                    error++;
                }
                if (!this.dcSet.isFork()) {
                    List<Trade> trades = this.dcSet.getTradeMap().getTrades(this.haveKey, this.wantKey);
                    if (trades.size() == 0) {
                        Long error = null;
                        error++;
                    }
                }

                //UPDATE FULFILLED HAVE
                order.setFulfilledHave(order.getFulfilledHave().add(tradeAmountHave)); // this.amountHave));
                this.setFulfilledHave(this.getFulfilledHave().add(tradeAmountWant)); //this.amountWant));

                if (order.isFulfilled()) {
                    //REMOVE FROM ORDERS
                    ordersMap.delete(order);

                    //ADD TO COMPLETED ORDERS
                    completedMap.add(order);
                } else {
                    //UPDATE ORDER
                    ordersMap.add(order);
                }

                //TRANSFER FUNDS
                order.getCreator().changeBalance(this.dcSet, false, order.getWant(), tradeAmountWant, false);

                // update new values
                thisAmountHaveLeft = this.getAmountHaveLeft();
                processedAmountFulfilledWant = processedAmountFulfilledWant.add(tradeAmountHave);

                if (!completedOrder
                        &&
                        // if can't trade by more good price than self - by orderOrice - then  auto cancel!
                        thisAmountHaveLeft.compareTo(thisIncrement) < 0) {
                    // cancel order if it not fulfiled isDivisible
                    // or HAVE not enough to one WANT  = price
                    ///CancelOrderTransaction.process_it(this.dcSet, this);
                    //and stop resolve
                    completedOrder = true;
                    // REVERT not completed AMOUNT
                    this.getCreator().changeBalance(this.dcSet, false,
                            this.haveKey, this.getAmountHaveLeft(), false);
                    break;
                }

            }
        }

        if (debug) {
            debug = true;
        }

        if (!completedOrder) {
            ordersMap.add(this);
        } else {
            completedMap.add(this);
        }

        //TRANSFER FUNDS
        this.getCreator().changeBalance(this.dcSet, false, this.getWant(), processedAmountFulfilledWant, false);

    }

    public void orphan() {

        CompletedOrderMap completedMap = this.dcSet.getCompletedOrderMap();
        OrderMap ordersMap = this.dcSet.getOrderMap();
        TradeMap tradesMap = this.dcSet.getTradeMap();

        //CHECK IF ORDER IS FULFILLED
        if (this.isFulfilled()) {
            //REMOVE FROM COMPLETED ORDERS
            completedMap.delete(this);
        }

        BigDecimal totalAmountFulfilledWant = BigDecimal.ZERO;

        //ORPHAN TRADES
        for (Trade trade : this.getInitiatedTrades(this.dcSet)) {
            Order target = trade.getTargetOrder(this.dcSet);

            //REVERSE FUNDS
            BigDecimal tradeAmountHave = trade.getAmountHave();
            BigDecimal tradeAmountWant = trade.getAmountWant();

            if (target.isFulfilled()) {
                //DELETE FROM COMPLETED ORDERS
                completedMap.delete(target);
            }

            //REVERSE FULFILLED
            target.setFulfilledHave(target.getFulfilledHave().subtract(tradeAmountHave));
            totalAmountFulfilledWant = totalAmountFulfilledWant.add(tradeAmountHave);

            target.getCreator().changeBalance(this.dcSet, true, target.getWant(), tradeAmountWant, false);

            //UPDATE ORDERS
            ordersMap.add(target);

            //REMOVE TRADE FROM DATABASE
            tradesMap.delete(trade);
        }

        //REMOVE ORDER FROM DATABASE
        ordersMap.delete(this);

        //REMOVE HAVE
        // GET HAVE LEFT - if it CANCELWED by INCREMENT close
        //   - если обработка остановлена по достижению порога Инкремента
        this.creator.changeBalance(this.dcSet, false, this.haveKey, this.getFulfilledHave(), true);
        //REVERT WANT
        this.creator.changeBalance(this.dcSet, true, this.wantKey, totalAmountFulfilledWant, false);
    }

	/*
	// TODO delete this
	// SCALE - different for ASSETS
	public BigDecimal calculateBuyIncrement()
	{
		BigInteger multiplier = BigInteger.valueOf(100000000l);

		//CALCULATE THE MINIMUM INCREMENT AT WHICH I CAN BUY USING GCD
		BigInteger haveAmount = BigInteger.ONE.multiply(multiplier);
		BigInteger priceAmount = this.getPriceCalc().multiply(new BigDecimal(multiplier), rounding)
				.setScale(this.getScaleForPrice(), RoundingMode.HALF_DOWN).toBigInteger();
		BigInteger gcd = haveAmount.gcd(priceAmount);
		haveAmount = haveAmount.divide(gcd);
		priceAmount = priceAmount.divide(gcd);

		//CALCULATE GCD IN COMBINATION WITH DIVISIBILITY
		if(true) //this.getWantAsset(this.dcSet).isDivisible())
		{
			haveAmount = haveAmount.multiply(multiplier);
		}
		if(true) //this.getHaveAsset(this.dcSet).isDivisible())
		{
			priceAmount = priceAmount.multiply(multiplier);
		}
		gcd = haveAmount.gcd(priceAmount);

		//CALCULATE THE INCREMENT AT WHICH WE HAVE TO BUY
		BigDecimal increment = new BigDecimal(haveAmount.divide(gcd));
		if(true) // this.getWantAsset(this.dcSet).isDivisible())
		{
			increment = increment.divide(new BigDecimal(multiplier));
		}

		//RETURN
		return increment;
	}
	 */

    //COMPARE

    //@Override
    @Override
    public int compareTo(Order order) {
        //COMPARE ONLY BY PRICE
        int result = this.getPrice().compareTo(order.getPrice());
        if (result != 0)
            return result;

        // TODO: REMOVE it in new CHAIN
        //if (this.timestamp < 1501816130973000l)
        //	return 0;

        long orderTimestamp = order.getTimestamp();
        if (this.timestamp < orderTimestamp)
            return -1;
        else if (this.timestamp > orderTimestamp)
            return 1;

        return 0;

    }

    @Override
    public String toString() {
        return this.id.toString();
    }

    //COPY
    public Order copy() {
		try
		{
			return parse(this.toBytes());
		}
		catch (Exception e)
		{
			return null;
		}
    }
}
